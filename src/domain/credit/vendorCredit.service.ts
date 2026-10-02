import prisma from "../../core/prismaClient";
import logger from "../../core/logger";
import { config } from "../../config";
import { getRedisClient, isRedisAvailable, markRedisError } from "../../core/redisClient";
import { SocketService } from "../../core/socket.service";
import { tz } from "../../utils/timezone";
import { Role } from "../../generated/prisma/client";

export type CreditStatus = "NORMAL" | "WARNING" | "BLOCKED" | "EXCEEDED_ALERT_ONLY";

export interface ValidateAndReserveResult {
  code: "OK" | "BLOCKED";
  projected: number;
  percentage: number;
  status: CreditStatus;
  limit?: number | null;
  failOpen?: boolean;
  degraded?: boolean;
}

export interface HydratedCreditState {
  limit: number | null;
  threshold: number;
  blockMode: boolean;
  baseBalance: number;
  openBySorteo: Record<string, number>;
  status: CreditStatus;
  bancaId: string | null;
  ventanaId: string | null;
  isActive?: boolean;
  updatedAt?: string;
}

export interface CreditStatusItem {
  vendedorId: string;
  creditLimit: number | null;
  effectiveBalance: number;
  percentageUsed: number;
  status: CreditStatus;
  updatedAt: string;
}

export interface CreditStatusResponse {
  enabled: boolean;
  items: CreditStatusItem[];
  truncated?: boolean;
}

const DEFAULT_TTL_SECONDS = 43200; // 12 horas
const REDIS_COMMAND_TIMEOUT_MS = 250; // Timeout estricto de comando Redis

// ─────────────────────────────────────────────────────────────────────────────
// SCRIPTS LUA ATÓMICOS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Script Lua: Valida topes y reserva atómicamente la venta en Redis.
 * Redondea a 2 decimales antes de comparar con el tope.
 * Para vendedores sin tope (-1), no reserva nada en open_by_sorteo.
 * BLOCKED refleja que el intento fue rechazado por alcanzar el tope de caja.
 * KEYS[1]: cfg key (vendedor:{id}:credit:cfg)
 * KEYS[2]: base key (vendedor:{id}:credit:base)
 * KEYS[3]: open_by_sorteo key (vendedor:{id}:credit:open_by_sorteo)
 * ARGV[1]: sorteoId
 * ARGV[2]: netAmount (monto neto de la venta a reservar)
 * ARGV[3]: defaultTTL (segundos)
 * Retorno: { code, projected, percentage, newStatus, oldStatus }
 */
export const CHECK_AND_RESERVE_LUA = `
if redis.call('exists', KEYS[1]) == 0 or redis.call('exists', KEYS[2]) == 0 then
  return {'NEEDS_HYDRATION', '0', '0', 'UNKNOWN', 'UNKNOWN'}
end

local base = tonumber(redis.call('get', KEYS[2])) or 0
local open_vals = redis.call('hvals', KEYS[3])
local open_total = 0
for _, val in ipairs(open_vals) do
  open_total = open_total + (tonumber(val) or 0)
end

local inc = tonumber(ARGV[2]) or 0
-- Redondeo defensivo a 2 decimales antes de comparar
local projected = math.floor((base + open_total + inc) * 100 + 0.5) / 100

local limit = tonumber(redis.call('hget', KEYS[1], 'limit'))
if not limit then
  return {'NEEDS_HYDRATION', '0', '0', 'UNKNOWN', 'UNKNOWN'}
end

local threshold = tonumber(redis.call('hget', KEYS[1], 'threshold')) or 80
local blockMode = tonumber(redis.call('hget', KEYS[1], 'blockMode')) or 1
local oldStatus = redis.call('hget', KEYS[1], 'status') or 'NORMAL'
local ttl = tonumber(ARGV[3]) or 43200

-- Caso 1: Vendedor sin límite (sentinela -1): NO reserva nada en open_by_sorteo
if limit == -1 then
  redis.call('hset', KEYS[1], 'status', 'NORMAL')
  redis.call('expire', KEYS[1], ttl)
  redis.call('expire', KEYS[2], ttl)
  return {'OK', tostring(projected), '0', 'NORMAL', oldStatus}
end

local pct = 0
if limit > 0 then
  pct = math.floor(((projected / limit) * 100) * 100 + 0.5) / 100
end

-- Caso 2: Excede el límite
if projected > limit then
  if blockMode == 1 then
    -- Modo Bloqueo estricto: NO reserva en open_by_sorteo.
    -- BLOCKED refleja que el intento fue rechazado por alcanzar el límite de caja.
    redis.call('hset', KEYS[1], 'status', 'BLOCKED')
    return {'BLOCKED', tostring(projected), tostring(pct), 'BLOCKED', oldStatus}
  else
    -- Modo Alerta solamente: SÍ reserva pero marca estado
    redis.call('hincrbyfloat', KEYS[3], ARGV[1], inc)
    redis.call('hset', KEYS[1], 'status', 'EXCEEDED_ALERT_ONLY')
    redis.call('expire', KEYS[1], ttl)
    redis.call('expire', KEYS[2], ttl)
    redis.call('expire', KEYS[3], ttl)
    return {'OK', tostring(projected), tostring(pct), 'EXCEEDED_ALERT_ONLY', oldStatus}
  end
end

-- Caso 3: Supera o iguala el umbral de alerta (advertencia)
if projected >= (limit * threshold / 100) then
  redis.call('hincrbyfloat', KEYS[3], ARGV[1], inc)
  redis.call('hset', KEYS[1], 'status', 'WARNING')
  redis.call('expire', KEYS[1], ttl)
  redis.call('expire', KEYS[2], ttl)
  redis.call('expire', KEYS[3], ttl)
  return {'OK', tostring(projected), tostring(pct), 'WARNING', oldStatus}
end

-- Caso 4: Operación normal
redis.call('hincrbyfloat', KEYS[3], ARGV[1], inc)
redis.call('hset', KEYS[1], 'status', 'NORMAL')
redis.call('expire', KEYS[1], ttl)
redis.call('expire', KEYS[2], ttl)
redis.call('expire', KEYS[3], ttl)
return {'OK', tostring(projected), tostring(pct), 'NORMAL', oldStatus}
`;

/**
 * Script Lua: Reemplazo atómico de base y open_by_sorteo para evitar carreras en updateBaseBalance.
 * KEYS[1]: base key (vendedor:{id}:credit:base)
 * KEYS[2]: open key (vendedor:{id}:credit:open_by_sorteo)
 * KEYS[3]: cfg key (vendedor:{id}:credit:cfg)
 * ARGV[1]: newBase
 * ARGV[2]: pairCount (número de pares key/value para open_by_sorteo)
 * ARGV[3]: newStatus
 * ARGV[4]: ttl
 * ARGV[5..]: sorteoId_1, amt_1, sorteoId_2, amt_2...
 */
export const ATOMIC_UPDATE_BASE_AND_OPEN_LUA = `
local ttl = tonumber(ARGV[4]) or 43200
local newBase = ARGV[1]
local pairCount = tonumber(ARGV[2]) or 0
local newStatus = ARGV[3]

-- 1. Actualizar base
redis.call('set', KEYS[1], newBase, 'EX', ttl)

-- 2. Limpiar y reconstruir open_by_sorteo atómicamente
redis.call('del', KEYS[2])
if pairCount > 0 then
  for i = 1, pairCount do
    local k = ARGV[4 + (i - 1) * 2 + 1]
    local v = ARGV[4 + (i - 1) * 2 + 2]
    redis.call('hset', KEYS[2], k, v)
  end
  redis.call('expire', KEYS[2], ttl)
end

-- 3. Actualizar status en cfg
local oldStatus = redis.call('hget', KEYS[3], 'status') or 'NORMAL'
redis.call('hset', KEYS[3], 'status', newStatus)
redis.call('expire', KEYS[3], ttl)

return oldStatus
`;

/**
 * Script Lua: Compensa o decrementa una reserva previa si la transacción falló o se anuló un ticket.
 * KEYS[1]: open_by_sorteo key
 * ARGV[1]: sorteoId
 * ARGV[2]: netAmount (monto neto a restar)
 */
export const COMPENSATE_LUA = `
local cur = tonumber(redis.call('hget', KEYS[1], ARGV[1])) or 0
local dec = tonumber(ARGV[2]) or 0
local new_val = cur - dec
if new_val <= 0.001 then
  redis.call('hdel', KEYS[1], ARGV[1])
else
  redis.call('hset', KEYS[1], ARGV[1], tostring(new_val))
end
return 'OK'
`;

/**
 * Helper con timeout defensivo para promesas asíncronas.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, errCode: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(errCode)), ms)
    ),
  ]);
}

interface DegradedApproval {
  amount: number;
  timestamp: number;
}

interface DegradedVendorCache {
  baseBalance: number;
  openSalesTotal: number;
  effectiveBalanceAtQuery: number;
  queryStartTime: number;
  expiresAt: number;
  limit: number | null;
  threshold: number;
  blockMode: boolean;
  status: CreditStatus;
  pendingDeltas: DegradedApproval[];
}

export class VendorCreditService {
  // Mapa de coalescencia en memoria para hidratación single-flight por vendedor
  private static hydrationLocks = new Map<string, Promise<HydratedCreditState>>();

  // Contador global de eventos fail-open
  private static failOpenCounter = 0;

  // Estado y caché en memoria para modo degradado (Fallback Nivel 2 y 3)
  private static degradedCache = new Map<string, DegradedVendorCache>();
  private static vendorDegradedMutexes = new Map<string, Promise<void>>();
  private static isDegradedMode = false;
  private static degradedModeEnteredAt = 0;
  private static degradedDecisionsCount = 0;
  private static vendorsApprovedInDegradedMode = new Set<string>();

  // Marcador en memoria del proceso de sorteos en evaluación
  private static inMemoryEvaluatingSorteos = new Map<string, number>();

  static getFailOpenCount(): number {
    return this.failOpenCounter;
  }

  static resetFailOpenCount(): void {
    this.failOpenCounter = 0;
  }

  static getDegradedDecisionsCount(): number {
    return this.degradedDecisionsCount;
  }

  static isDegraded(): boolean {
    return this.isDegradedMode;
  }

  static resetDegradedState(): void {
    this.isDegradedMode = false;
    this.degradedModeEnteredAt = 0;
    this.degradedDecisionsCount = 0;
    this.vendorsApprovedInDegradedMode.clear();
    this.degradedCache.clear();
    this.inMemoryEvaluatingSorteos.clear();
  }

  static enterDegradedMode(reason: string): void {
    if (this.isDegradedMode) return;
    this.isDegradedMode = true;
    this.degradedModeEnteredAt = Date.now();
    logger.warn({
      layer: "credit",
      action: "CREDIT_DEGRADED_MODE_ENTERED",
      payload: {
        reason,
        timestamp: new Date(this.degradedModeEnteredAt).toISOString(),
      },
    });
  }

  static async exitDegradedMode(): Promise<void> {
    if (!this.isDegradedMode) return;
    const durationMs = Date.now() - this.degradedModeEnteredAt;
    const decisionsCount = this.degradedDecisionsCount;
    const vendorsToRecover = Array.from(this.vendorsApprovedInDegradedMode);

    this.isDegradedMode = false;
    this.degradedModeEnteredAt = 0;
    this.vendorsApprovedInDegradedMode.clear();
    this.degradedCache.clear();

    logger.info({
      layer: "credit",
      action: "CREDIT_DEGRADED_MODE_EXITED",
      payload: {
        durationMs,
        decisionsCount,
        vendorsRecoveredCount: vendorsToRecover.length,
      },
    });

    // Invalida en Redis las claves de los vendedores que fueron aprobados en modo degradado
    // para forzar rehidratación limpia y evitar subconteo
    for (const vId of vendorsToRecover) {
      try {
        await this.invalidateKeys(vId);
      } catch (err: any) {
        logger.warn({
          layer: "credit",
          action: "RECOVERY_INVALIDATE_ERROR",
          payload: { vendedorId: vId, error: err?.message || String(err) },
        });
      }
    }
  }

  private static async withVendorDegradedMutex<T>(
    vendedorId: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const prev = this.vendorDegradedMutexes.get(vendedorId) || Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.vendorDegradedMutexes.set(vendedorId, prev.then(() => current, () => current));
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.vendorDegradedMutexes.get(vendedorId) === current) {
        this.vendorDegradedMutexes.delete(vendedorId);
      }
    }
  }

  private static getKeys(vendedorId: string) {
    return {
      cfg: `vendedor:${vendedorId}:credit:cfg`,
      base: `vendedor:${vendedorId}:credit:base`,
      open: `vendedor:${vendedorId}:credit:open_by_sorteo`,
    };
  }

  private static readonly EVALUATING_SORTEOS_KEY = "sorteos:evaluating";
  private static readonly BLOCKED_DEBOUNCE_MS = 15000;
  private static lastBlockedEmitTime = new Map<string, number>();
  private static listScopeCache = new Map<string, { data: CreditStatusResponse; expiresAt: number }>();

  /**
   * Función pura para cálculo determinista de CreditStatus según los bordes de negocio:
   * 1. Sin límite (limit === null o limit <= 0): siempre 'NORMAL'.
   * 2. effectiveBalance > creditLimit:
   *    - Si creditBlockMode es true => 'BLOCKED'.
   *    - Si creditBlockMode es false => 'EXCEEDED_ALERT_ONLY'.
   * 3. effectiveBalance >= (creditLimit * creditAlertThreshold) / 100 => 'WARNING'.
   * 4. En cualquier otro caso => 'NORMAL'.
   */
  static computeCreditStatus(
    effectiveBalance: number,
    creditLimit: number | null | undefined,
    creditAlertThreshold: number = 80,
    creditBlockMode: boolean = true
  ): CreditStatus {
    if (creditLimit === null || creditLimit === undefined || creditLimit <= 0) {
      return "NORMAL";
    }

    if (effectiveBalance > creditLimit) {
      return creditBlockMode ? "BLOCKED" : "EXCEEDED_ALERT_ONLY";
    }

    if (effectiveBalance >= (creditLimit * creditAlertThreshold) / 100) {
      return "WARNING";
    }

    return "NORMAL";
  }

  /**
   * Marca un sorteo como 'en evaluación' en memoria del proceso y en Redis antes de invocar fn_evaluate_sorteo.
   * Utiliza un Sorted Set con timestamp de expiración (TTL configurable, default 15 min / 900s).
   * Mantiene el estado en memoria para modo degradado (límite en despliegue multi-instancia: local al proceso).
   */
  static async markSorteoEvaluating(sorteoId: string): Promise<void> {
    const ttlSec = config.creditLimit.evaluatingSorteoTtlSeconds || 900;
    const expiresAt = Date.now() + ttlSec * 1000;
    this.inMemoryEvaluatingSorteos.set(sorteoId, expiresAt);

    if (!config.creditLimit.enabled || !isRedisAvailable()) return;
    const redis = getRedisClient();
    if (!redis) return;
    try {
      await redis.zadd(this.EVALUATING_SORTEOS_KEY, expiresAt, sorteoId);
      await redis.expire(this.EVALUATING_SORTEOS_KEY, ttlSec * 2);
    } catch (err: any) {
      markRedisError("VendorCreditService.markSorteoEvaluating");
    }
  }

  /**
   * Desmarca un sorteo como 'en evaluación' una vez completada la sincronización contable y reconciliación.
   */
  static async unmarkSorteoEvaluating(sorteoId: string): Promise<void> {
    this.inMemoryEvaluatingSorteos.delete(sorteoId);

    if (!config.creditLimit.enabled || !isRedisAvailable()) return;
    const redis = getRedisClient();
    if (!redis) return;
    try {
      await redis.zrem(this.EVALUATING_SORTEOS_KEY, sorteoId);
    } catch (err: any) {
      markRedisError("VendorCreditService.unmarkSorteoEvaluating");
    }
  }

  /**
   * Obtiene la lista de sorteos actualmente en proceso de evaluación purgando automáticamente expirados.
   * Fusiona el marcador en memoria del proceso con Redis (o solo memoria si Redis no está disponible).
   */
  static async getEvaluatingSorteoIds(): Promise<string[]> {
    const now = Date.now();
    for (const [id, exp] of this.inMemoryEvaluatingSorteos.entries()) {
      if (exp <= now) this.inMemoryEvaluatingSorteos.delete(id);
    }
    const inMemIds = Array.from(this.inMemoryEvaluatingSorteos.keys());

    if (!config.creditLimit.enabled || !isRedisAvailable()) return inMemIds;
    const redis = getRedisClient();
    if (!redis) return inMemIds;
    try {
      await redis.zremrangebyscore(this.EVALUATING_SORTEOS_KEY, "-inf", now);
      const redisIds = await redis.zrangebyscore(this.EVALUATING_SORTEOS_KEY, now, "+inf");
      const merged = new Set([...inMemIds, ...(redisIds || [])]);
      return Array.from(merged);
    } catch (err: any) {
      markRedisError("VendorCreditService.getEvaluatingSorteoIds");
      return inMemIds;
    }
  }

  /**
   * Consulta las ventas abiertas no consolidadas para un vendedor dentro de la ventana de fechas.
   * windowDate se normaliza a string 'YYYY-MM-DD' en hora de Costa Rica para evitar conversiones UTC/local en PostgreSQL.
   */
  static async fetchOpenSales(
    vendedorId: string,
    windowDate: Date | string
  ): Promise<Array<{ sorteoId: string; netAmount: string | number }>> {
    const windowDateStr = typeof windowDate === "string" ? windowDate : tz.toDateStr(windowDate);
    const evaluatingIds = await this.getEvaluatingSorteoIds();

    if (evaluatingIds && evaluatingIds.length > 0) {
      return prisma.$queryRaw<Array<{ sorteoId: string; netAmount: string | number }>>`
        SELECT 
          t."sorteoId"::text AS "sorteoId",
          COALESCE(SUM(
            j.amount - CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END
          ), 0)::numeric AS "netAmount"
        FROM "Ticket" t
        INNER JOIN "Sorteo" s ON s.id = t."sorteoId"
        INNER JOIN "Jugada" j ON j."ticketId" = t.id
        WHERE t."vendedorId" = ${vendedorId}::uuid
          AND t."businessDate" >= CAST(${windowDateStr} AS date)
          AND t."status" NOT IN ('CANCELLED'::"TicketStatus", 'EXCLUDED'::"TicketStatus")
          AND t."isActive" = true
          AND t."deletedAt" IS NULL
          AND (s."status" <> 'EVALUATED'::"SorteoStatus" OR s.id = ANY(${evaluatingIds}::uuid[]))
          AND s."deletedAt" IS NULL
          AND j."isActive" = true
          AND j."deletedAt" IS NULL
        GROUP BY t."sorteoId"
      `;
    }

    return prisma.$queryRaw<Array<{ sorteoId: string; netAmount: string | number }>>`
      SELECT 
        t."sorteoId"::text AS "sorteoId",
        COALESCE(SUM(
          j.amount - CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END
        ), 0)::numeric AS "netAmount"
      FROM "Ticket" t
      INNER JOIN "Sorteo" s ON s.id = t."sorteoId"
      INNER JOIN "Jugada" j ON j."ticketId" = t.id
      WHERE t."vendedorId" = ${vendedorId}::uuid
        AND t."businessDate" >= CAST(${windowDateStr} AS date)
        AND t."status" NOT IN ('CANCELLED'::"TicketStatus", 'EXCLUDED'::"TicketStatus")
        AND t."isActive" = true
        AND t."deletedAt" IS NULL
        AND s."status" <> 'EVALUATED'::"SorteoStatus"
        AND s."deletedAt" IS NULL
        AND j."isActive" = true
        AND j."deletedAt" IS NULL
      GROUP BY t."sorteoId"
    `;
  }

  /**
   * Valida el crédito disponible y reserva el monto en Redis de manera atómica (Pre-vuelo).
   * El timeout estricto de 250ms aplica EXCLUSIVAMENTE a la ejecución del comando Redis.
   * Si Redis no está disponible o falla, aplica FALLBACK ESCALONADO:
   *  - Nivel 2: Cálculo desde PostgreSQL (pool general) con caché en proceso y delta tracking.
   *  - Nivel 3: Fail-open defensivo con log de error y contador si PostgreSQL también falla o excede timeout.
   */
  static async validateAndReserve(
    vendedorId: string,
    sorteoId: string,
    netAmount: number
  ): Promise<ValidateAndReserveResult> {
    if (!config.creditLimit.enabled) {
      return { code: "OK", projected: 0, percentage: 0, status: "NORMAL" };
    }

    // Si Redis no está disponible o cliente en estado terminal, entrar a modo degradado (Nivel 2)
    if (!isRedisAvailable()) {
      this.enterDegradedMode("Redis client not available");
      return this.validateAndReserveDegraded(vendedorId, sorteoId, netAmount);
    }

    const redis = getRedisClient();
    if (!redis) {
      this.enterDegradedMode("Redis client is null");
      return this.validateAndReserveDegraded(vendedorId, sorteoId, netAmount);
    }

    // Si estábamos en modo degradado y Redis volvió a funcionar, recuperar e invalidar claves viejas
    if (this.isDegradedMode) {
      await this.exitDegradedMode();
    }

    const { cfg, base, open } = this.getKeys(vendedorId);

    // Ejecuta el script Lua de validación y reserva con timeout aislado de 250ms en Redis
    const executeRedisCommand = async (): Promise<[string, string, string, CreditStatus, CreditStatus]> => {
      try {
        const raw = await withTimeout(
          redis.eval(
            CHECK_AND_RESERVE_LUA,
            3,
            cfg,
            base,
            open,
            sorteoId,
            netAmount.toString(),
            DEFAULT_TTL_SECONDS.toString()
          ),
          REDIS_COMMAND_TIMEOUT_MS,
          "REDIS_COMMAND_TIMEOUT"
        );
        return raw as [string, string, string, CreditStatus, CreditStatus];
      } catch (err: any) {
        markRedisError("VendorCreditService.validateAndReserve.command");
        throw err;
      }
    };

    try {
      let [code, projectedStr, percentageStr, status, oldStatus] = await executeRedisCommand();

      // Si Redis requiere hidratación previa desde BD
      if (code === "NEEDS_HYDRATION") {
        const hydrationTimeoutMs = config.creditLimit.hydrationTimeoutMs || 1000;
        let hydrated: HydratedCreditState;
        try {
          hydrated = await withTimeout(
            this.hydrate(vendedorId),
            hydrationTimeoutMs,
            "DB_HYDRATION_TIMEOUT"
          );
        } catch (hydrationErr: any) {
          logger.warn({
            layer: "credit",
            action: "HYDRATION_FAILED_ENTERING_DEGRADED",
            payload: { vendedorId, error: hydrationErr?.message },
          });
          this.enterDegradedMode("Hydration failed");
          return this.validateAndReserveDegraded(vendedorId, sorteoId, netAmount);
        }

        // Reintentar comando Redis tras hidratación exitosa UNA vez
        try {
          const retryResult = await executeRedisCommand();
          [code, projectedStr, percentageStr, status, oldStatus] = retryResult;
        } catch (retryErr: any) {
          logger.warn({
            layer: "credit",
            action: "REDIS_RETRY_FAILED_ENTERING_DEGRADED",
            payload: { vendedorId, error: retryErr?.message },
          });
          this.enterDegradedMode("Redis retry after hydration failed");
          return this.validateAndReserveDegraded(vendedorId, sorteoId, netAmount);
        }

        // Si aún así no devuelve OK o BLOCKED (código no terminal o NEEDS_HYDRATION persistente):
        // Evaluar con computeCreditStatus sobre los datos recién hidratados y aplicar el bloqueo según el modo
        if (code !== "OK" && code !== "BLOCKED") {
          logger.warn({
            layer: "credit",
            action: "REDIS_RETRY_NON_TERMINAL_CODE",
            payload: {
              vendedorId,
              sorteoId,
              code,
              retryResult: [code, projectedStr, percentageStr, status, oldStatus],
            },
          });
          const openTotalHydrated = Object.values(hydrated.openBySorteo).reduce((a, b) => a + b, 0);
          const projected = Math.round((hydrated.baseBalance + openTotalHydrated + netAmount) * 100) / 100;
          const percentage = hydrated.limit && hydrated.limit > 0
            ? Math.round(((projected / hydrated.limit) * 100) * 100) / 100
            : 0;
          const fallbackStatus = this.computeCreditStatus(
            projected,
            hydrated.limit,
            hydrated.threshold,
            hydrated.blockMode
          );
          const finalCode: "OK" | "BLOCKED" = fallbackStatus === "BLOCKED" ? "BLOCKED" : "OK";
          return {
            code: finalCode,
            projected,
            percentage,
            status: fallbackStatus,
            limit: hydrated.limit,
          };
        }
      }

      // Validar lista cerrada de códigos ("OK" o "BLOCKED")
      if (code !== "OK" && code !== "BLOCKED") {
        logger.error({
          layer: "credit",
          action: "UNEXPECTED_REDIS_RETURN_CODE",
          payload: { vendedorId, sorteoId, code },
        });
        this.enterDegradedMode(`Unexpected code: ${code}`);
        return this.validateAndReserveDegraded(vendedorId, sorteoId, netAmount);
      }

      const projected = parseFloat(projectedStr) || 0;
      const percentage = parseFloat(percentageStr) || 0;

      // Leer límite configurado para adjuntar a creditInfo
      let limit: number | null = null;
      try {
        const lStr = await redis.hget(cfg, "limit");
        if (lStr && lStr !== "-1") limit = parseFloat(lStr);
      } catch {}

      // Emitir WebSocket ÚNICAMENTE ante transición de estado
      if (status !== oldStatus) {
        this.emitCreditStatusChanged(vendedorId, projected, percentage, status).catch(() => {});
      }

      return {
        code: code as "OK" | "BLOCKED",
        projected,
        percentage,
        status,
        limit,
      };
    } catch (err: any) {
      markRedisError("VendorCreditService.validateAndReserve.failOpen");
      this.enterDegradedMode(err?.message || "Redis command failed or timed out");
      return this.validateAndReserveDegraded(vendedorId, sorteoId, netAmount);
    }
  }

  static async resolveDegradedFallback(
    vendedorId: string,
    sorteoId: string,
    netAmount: number,
    reason: string
  ): Promise<ValidateAndReserveResult> {
    this.enterDegradedMode(reason);
    return this.validateAndReserveDegraded(vendedorId, sorteoId, netAmount);
  }

  /**
   * FALLBACK ESCALONADO:
   * Nivel 2: Cálculo en proceso desde PostgreSQL con pool general, caché corta (2-5s) y delta tracking.
   * Nivel 3: Fail-Open si PostgreSQL falla o supera timeout, con log de error y contador visible.
   */
  private static async validateAndReserveDegraded(
    vendedorId: string,
    sorteoId: string,
    netAmount: number
  ): Promise<ValidateAndReserveResult> {
    return this.withVendorDegradedMutex(vendedorId, async () => {
      const now = Date.now();
      const cached = this.degradedCache.get(vendedorId);
      const ttlMs = config.creditLimit.degradedTtlMs || 3000;

      let baseBalance = 0;
      let openSalesTotal = 0;
      let effectiveBalanceAtQuery = 0;
      let limit: number | null = null;
      let threshold = 80;
      let blockMode = true;
      let bancaId: string | null = null;
      let ventanaId: string | null = null;
      let queryStartTime = now;
      let survivingDeltas: DegradedApproval[] = [];

      if (cached && cached.expiresAt > now) {
        // Usar estado en memoria válido del proceso
        baseBalance = cached.baseBalance;
        openSalesTotal = cached.openSalesTotal;
        effectiveBalanceAtQuery = cached.effectiveBalanceAtQuery;
        limit = cached.limit;
        threshold = cached.threshold;
        blockMode = cached.blockMode;
        survivingDeltas = cached.pendingDeltas;
      } else {
        // Requiere cálculo desde PostgreSQL (Nivel 2) con timeout corto
        queryStartTime = Date.now();
        const dbTimeoutMs = config.creditLimit.degradedDbTimeoutMs || 1000;

        try {
          const dbCalculation = async () => {
            // 1. Obtener vendedor desde pool general (NUNCA salesPrisma)
            const vendor = await prisma.user.findUnique({
              where: { id: vendedorId },
              select: {
                id: true,
                creditLimit: true,
                creditAlertThreshold: true,
                creditBlockMode: true,
                settings: true,
                ventanaId: true,
                bancaId: true,
                ventana: { select: { bancaId: true } },
              },
            });

            if (!vendor) {
              throw new Error(`Vendor ${vendedorId} not found during degraded credit check`);
            }

            const effectiveLimit = vendor.creditLimit ?? null;
            const effectiveThreshold = vendor.creditAlertThreshold ?? 80;
            const effectiveBlockMode = vendor.creditBlockMode ?? true;
            bancaId = vendor.bancaId || vendor.ventana?.bancaId || null;
            ventanaId = vendor.ventanaId || null;

            // 2. Obtener saldo base desde AccountStatement
            const todayCRStr = tz.toDateStr();
            const todayDateUTC = tz.parse(todayCRStr);

            const lastStatement = await prisma.accountStatement.findFirst({
              where: {
                vendedorId,
                date: { lte: todayDateUTC },
              },
              orderBy: { date: "desc" },
              select: { accumulatedBalance: true, date: true },
            });

            let calculatedBase = 0;
            if (lastStatement) {
              calculatedBase = lastStatement.accumulatedBalance ?? 0;
              const resetAt = (vendor.settings as any)?.balanceResetAt;
              if (resetAt && new Date(lastStatement.date).getTime() < new Date(resetAt).getTime()) {
                calculatedBase = 0;
              }
            }

            // 3. Ventas abiertas de sorteos no consolidados
            const daysWindow = config.creditLimit.openSalesDaysWindow || 2;
            const windowDateUTC = new Date(todayDateUTC.getTime() - daysWindow * 24 * 60 * 60 * 1000);
            const windowDateStr = tz.toDateStr(windowDateUTC);

            const openSales = await this.fetchOpenSales(vendedorId, windowDateStr);
            let calculatedOpen = 0;
            for (const row of openSales) {
              const val = parseFloat(String(row.netAmount)) || 0;
              if (val > 0) calculatedOpen += val;
            }

            return {
              calculatedBase,
              calculatedOpen,
              limit: effectiveLimit,
              threshold: effectiveThreshold,
              blockMode: effectiveBlockMode,
              bancaId,
              ventanaId,
            };
          };

          const dbRes = await withTimeout(
            dbCalculation(),
            dbTimeoutMs,
            "DEGRADED_DB_TIMEOUT"
          );

          baseBalance = dbRes.calculatedBase;
          openSalesTotal = dbRes.calculatedOpen;
          effectiveBalanceAtQuery = Math.round((baseBalance + openSalesTotal) * 100) / 100;
          limit = dbRes.limit;
          threshold = dbRes.threshold;
          blockMode = dbRes.blockMode;
          bancaId = dbRes.bancaId;
          ventanaId = dbRes.ventanaId;

          // EVITAR DOBLE CONTEO (src/domain/credit/vendorCredit.service.ts):
          // Descartamos del delta local cualquier ticket aprobado antes del inicio de la consulta (queryStartTime),
          // ya que esas ventas ya están incluidas en las filas leídas de PostgreSQL.
          survivingDeltas = (cached?.pendingDeltas || []).filter(
            (d) => d.timestamp >= queryStartTime
          );
        } catch (dbErr: any) {
          // NIVEL 3: Fail-Open si PostgreSQL también falla o supera el timeout
          this.failOpenCounter++;
          this.degradedDecisionsCount++;
          logger.error({
            layer: "credit",
            action: "ALERT_CREDIT_CHECK_FAIL_OPEN",
            payload: {
              vendedorId,
              sorteoId,
              netAmount,
              reason: "Degraded PostgreSQL calculation failed or timed out",
              error: dbErr?.message || String(dbErr),
              failOpenCount: this.failOpenCounter,
            },
          });
          return {
            code: "OK",
            projected: 0,
            percentage: 0,
            status: "NORMAL",
            failOpen: true,
            degraded: true,
          };
        }
      }

      // Calcular saldo proyectado sumando la base confirmada, el delta local en vuelo y la venta entrante
      const localDeltaSum = survivingDeltas.reduce((s, d) => s + d.amount, 0);
      const projected = Math.round((effectiveBalanceAtQuery + localDeltaSum + netAmount) * 100) / 100;
      const percentage = limit && limit > 0
        ? Math.round(((projected / limit) * 100) * 100) / 100
        : 0;
      const newStatus = this.computeCreditStatus(projected, limit, threshold, blockMode);
      const oldStatus = cached?.status || "NORMAL";

      this.degradedDecisionsCount++;

      const updatedCache: DegradedVendorCache = {
        baseBalance,
        openSalesTotal,
        effectiveBalanceAtQuery,
        queryStartTime,
        expiresAt: Date.now() + ttlMs,
        limit,
        threshold,
        blockMode,
        status: newStatus,
        pendingDeltas: [...survivingDeltas],
      };

      if (newStatus === "BLOCKED") {
        this.degradedCache.set(vendedorId, updatedCache);
        if (newStatus !== oldStatus) {
          this.emitCreditStatusChanged(vendedorId, projected, percentage, newStatus, {
            limit,
            bancaId,
            ventanaId,
          }).catch(() => {});
        }
        return {
          code: "BLOCKED",
          projected,
          percentage,
          status: newStatus,
          limit,
          degraded: true,
        };
      }

      // Venta aprobada en modo degradado: registrar delta local y marcar vendedor para recuperación
      updatedCache.pendingDeltas.push({ amount: netAmount, timestamp: Date.now() });
      this.degradedCache.set(vendedorId, updatedCache);
      this.vendorsApprovedInDegradedMode.add(vendedorId);

      if (newStatus !== oldStatus) {
        this.emitCreditStatusChanged(vendedorId, projected, percentage, newStatus, {
          limit,
          bancaId,
          ventanaId,
        }).catch(() => {});
      }

      return {
        code: "OK",
        projected,
        percentage,
        status: newStatus,
        limit,
        degraded: true,
      };
    });
  }

  /**
   * Compensa el monto reservado en Redis si la transacción interactiva en PostgreSQL falló.
   * Si la compensación falla, invalida inmediatamente las claves del vendedor y registra el error.
   */
  static async compensateReservation(
    vendedorId: string,
    sorteoId: string,
    netAmount: number
  ): Promise<void> {
    // Si hay deltas en memoria en modo degradado, compensar el delta
    const cached = this.degradedCache.get(vendedorId);
    if (cached) {
      const idx = cached.pendingDeltas.findIndex(
        (d) => Math.abs(d.amount - netAmount) < 0.01
      );
      if (idx !== -1) {
        cached.pendingDeltas.splice(idx, 1);
      }
    }

    if (!config.creditLimit.enabled || !isRedisAvailable()) return;

    const redis = getRedisClient();
    if (!redis) return;

    const { open } = this.getKeys(vendedorId);

    try {
      await redis.eval(COMPENSATE_LUA, 1, open, sorteoId, netAmount.toString());
      logger.debug({
        layer: "credit",
        action: "CREDIT_RESERVATION_COMPENSATED",
        payload: { vendedorId, sorteoId, netAmount },
      });

      // Si el decremento provoca transición de estado (ej: de WARNING a NORMAL), actualizar status y notificar por socket
      try {
        if (typeof redis.get === "function" && typeof redis.hgetall === "function") {
          const { cfg, base } = this.getKeys(vendedorId);
          const [baseStr, openMap, cfgData] = await Promise.all([
            redis.get(base),
            redis.hgetall(open),
            redis.hgetall(cfg),
          ]);
        if (cfgData && cfgData.limit) {
          const baseNum = parseFloat(baseStr || "0") || 0;
          const openTotal = Object.values(openMap || {}).reduce(
            (acc: number, v: any) => acc + (parseFloat(v as string) || 0),
            0
          );
          const projected = Math.round((baseNum + openTotal) * 100) / 100;
          const limit = cfgData.limit !== "-1" ? parseFloat(cfgData.limit) : null;
          const threshold = parseFloat(cfgData.threshold || "80");
          const blockMode = cfgData.blockMode === "1";
          const oldStatus = (cfgData.status as CreditStatus) || "NORMAL";
          const newStatus = this.computeCreditStatus(projected, limit, threshold, blockMode);

            if (newStatus !== oldStatus) {
              await redis.hset(cfg, "status", newStatus);
              const percentage = limit && limit > 0
                ? Math.round(((projected / limit) * 100) * 100) / 100
                : 0;
              this.emitCreditStatusChanged(vendedorId, projected, percentage, newStatus).catch(() => {});
            }
          }
        }
      } catch (stErr: any) {
        logger.warn({
          layer: "credit",
          action: "COMPENSATE_STATUS_CHECK_WARN",
          payload: { vendedorId, error: stErr?.message || String(stErr) },
        });
      }
    } catch (err: any) {
      markRedisError("VendorCreditService.compensateReservation");
      logger.error({
        layer: "credit",
        action: "COMPENSATE_RESERVATION_ERROR_INVALIDATING",
        payload: { vendedorId, sorteoId, error: err?.message || String(err) },
      });
      // En caso de fallo en compensación, invalidar claves para forzar rehidratación limpia
      await this.invalidateKeys(vendedorId).catch((invErr) => {
        logger.error({
          layer: "credit",
          action: "INVALIDATE_KEYS_AFTER_COMPENSATION_FAIL_ERROR",
          payload: { vendedorId, error: invErr?.message || String(invErr) },
        });
      });
      throw err;
    }
  }

  /**
   * Hidrata las claves de crédito del vendedor desde PostgreSQL (Single-Flight).
   * Consulta optimizada con ventana acotada de días y agregación sobre Jugada sin correlated subquery.
   */
  static async hydrate(vendedorId: string): Promise<HydratedCreditState> {
    const existingPromise = this.hydrationLocks.get(vendedorId);
    if (existingPromise) {
      return existingPromise;
    }

    const hydrationPromise = (async () => {
      try {
        const { cfg, base, open } = this.getKeys(vendedorId);

        // 1. Obtener configuración y relaciones del vendedor
        const vendor = await prisma.user.findUnique({
          where: { id: vendedorId },
          select: {
            id: true,
            creditLimit: true,
            creditAlertThreshold: true,
            creditBlockMode: true,
            settings: true,
            ventanaId: true,
            bancaId: true,
            isActive: true,
            updatedAt: true,
            ventana: { select: { bancaId: true } },
          },
        });

        if (!vendor) {
          throw new Error(`Vendor ${vendedorId} not found during credit hydration`);
        }

        const effectiveBancaId = vendor.bancaId || vendor.ventana?.bancaId || null;
        const limit = vendor.creditLimit !== null && vendor.creditLimit !== undefined && vendor.creditLimit > 0
          ? vendor.creditLimit
          : null;
        const threshold = vendor.creditAlertThreshold ?? 80;
        const blockMode = vendor.creditBlockMode ?? true;
        const vendorUpdatedAt = vendor.updatedAt ? vendor.updatedAt.toISOString() : new Date().toISOString();
        const hasLimit = limit !== null && limit > 0;

        let baseBalance = 0;
        const openBySorteo: Record<string, number> = {};
        let totalOpen = 0;
        let projected = 0;

        // Vendedores con tope configurado (>0): cargar balances y ventas abiertas reales desde BD
        if (hasLimit) {
          // 2. Obtener saldo base desde el último AccountStatement con date <= hoy
          const todayCRStr = tz.toDateStr();
          const todayDateUTC = tz.parse(todayCRStr);

          const lastStatement = await prisma.accountStatement.findFirst({
            where: {
              vendedorId,
              date: { lte: todayDateUTC },
            },
            orderBy: { date: "desc" },
            select: { accumulatedBalance: true, date: true },
          });

          if (lastStatement) {
            baseBalance = lastStatement.accumulatedBalance ?? 0;

            // Respetar reset de balance si fue configurado en settings
            const resetAt = (vendor.settings as any)?.balanceResetAt;
            if (resetAt && new Date(lastStatement.date).getTime() < new Date(resetAt).getTime()) {
              baseBalance = 0;
            }
          }

          // 3. Ventana acotada de días para ventas abiertas (businessDate >= hoy - N días en zona Costa Rica)
          const daysWindow = config.creditLimit.openSalesDaysWindow || 2;
          const windowDateUTC = new Date(todayDateUTC.getTime() - daysWindow * 24 * 60 * 60 * 1000);
          const windowDateStr = tz.toDateStr(windowDateUTC);

          // 4. Obtener ventas netas abiertas sin correlated subquery por ticket
          const openSales = await this.fetchOpenSales(vendedorId, windowDateStr);

          for (const row of openSales) {
            const val = parseFloat(String(row.netAmount)) || 0;
            if (val > 0) {
              openBySorteo[row.sorteoId] = val;
              totalOpen += val;
            }
          }

          projected = Math.round((baseBalance + totalOpen) * 100) / 100;
        }

        const status = hasLimit ? this.computeCreditStatus(projected, limit, threshold, blockMode) : "NORMAL";

        // 5. Guardar en Redis mediante pipeline
        if (isRedisAvailable()) {
          const redis = getRedisClient();
          if (redis) {
            const pipeline = redis.pipeline();
            pipeline.del(cfg, base, open);

            pipeline.hset(cfg, {
              limit: limit !== null ? limit.toString() : "-1",
              threshold: threshold.toString(),
              blockMode: blockMode ? "1" : "0",
              status,
              bancaId: effectiveBancaId || "",
              ventanaId: vendor.ventanaId || "",
              isActive: vendor.isActive ? "1" : "0",
              updatedAt: vendorUpdatedAt,
            });
            pipeline.expire(cfg, DEFAULT_TTL_SECONDS);

            pipeline.set(base, baseBalance.toString(), "EX", DEFAULT_TTL_SECONDS);

            if (Object.keys(openBySorteo).length > 0) {
              const stringMap: Record<string, string> = {};
              for (const [sId, amt] of Object.entries(openBySorteo)) {
                stringMap[sId] = amt.toString();
              }
              pipeline.hset(open, stringMap);
              pipeline.expire(open, DEFAULT_TTL_SECONDS);
            }

            await pipeline.exec();
          }
        }

        return {
          limit,
          threshold,
          blockMode,
          baseBalance,
          openBySorteo,
          status,
          bancaId: effectiveBancaId,
          ventanaId: vendor.ventanaId,
          isActive: vendor.isActive,
          updatedAt: vendorUpdatedAt,
        };
      } finally {
        this.hydrationLocks.delete(vendedorId);
      }
    })();

    this.hydrationLocks.set(vendedorId, hydrationPromise);
    return hydrationPromise;
  }

  /**
   * Actualiza el saldo base del vendedor tras un cobro, pago o sincronización de AccountStatement.
   * Lee el último AccountStatement con date <= hoy (aplicando balanceResetAt) y recalcula
   * open_by_sorteo desde BD.
   *
   * RIESGO ACEPTADO DOCUMENTADO:
   * Durante el instante en que updateBaseBalance lee de PostgreSQL y actualiza Redis, reservas concurrentes
   * en vuelo (tickets en pre-vuelo que aún no han hecho commit en PostgreSQL) podrían ser reemplazadas
   * por el estado confirmado de BD. Este riesgo de ventana es intrínseco al modelo de caché de saldo proyectado
   * y queda acotado por la corta duración de la transacción interactiva (<20ms).
   *
   * Aplica reemplazo atómico mediante ATOMIC_UPDATE_BASE_AND_OPEN_LUA.
   */
  static async updateBaseBalance(vendedorId: string): Promise<void> {
    if (!config.creditLimit.enabled || !isRedisAvailable()) return;

    const redis = getRedisClient();
    if (!redis) return;

    const { cfg, base, open } = this.getKeys(vendedorId);

    try {
      const exists = await redis.exists(cfg);
      if (!exists) {
        // Clave no hidratada aún; hidratará cuando sea consultada
        return;
      }

      // Verificación rápida en Redis: si el vendedor ya está marcado con limit == -1 o <= 0, abortar inmediatamente
      try {
        const lStr = await redis.hget(cfg, "limit");
        if (lStr === "-1") {
          return;
        }
        if (lStr) {
          const parsed = parseFloat(lStr);
          if (!isNaN(parsed) && parsed <= 0) return;
        }
      } catch {}

      // 1. Obtener configuración del vendedor
      const vendor = await prisma.user.findUnique({
        where: { id: vendedorId },
        select: {
          id: true,
          creditLimit: true,
          creditAlertThreshold: true,
          creditBlockMode: true,
          settings: true,
        },
      });

      if (!vendor || vendor.creditLimit === null || vendor.creditLimit === undefined || vendor.creditLimit <= 0) {
        return;
      }

      const limit = vendor.creditLimit;
      const threshold = vendor.creditAlertThreshold ?? 80;
      const blockMode = vendor.creditBlockMode ?? true;

      // 2. Leer el último AccountStatement con date <= hoy
      const todayCRStr = tz.toDateStr();
      const todayDateUTC = tz.parse(todayCRStr);

      const lastStatement = await prisma.accountStatement.findFirst({
        where: {
          vendedorId,
          date: { lte: todayDateUTC },
        },
        orderBy: { date: "desc" },
        select: { accumulatedBalance: true, date: true },
      });

      let baseBalance = 0;
      if (lastStatement) {
        baseBalance = lastStatement.accumulatedBalance ?? 0;
        const resetAt = (vendor.settings as any)?.balanceResetAt;
        if (resetAt && new Date(lastStatement.date).getTime() < new Date(resetAt).getTime()) {
          baseBalance = 0;
        }
      }

      // 3. Ventana acotada de días para ventas abiertas (businessDate >= hoy - N días en zona Costa Rica)
      const daysWindow = config.creditLimit.openSalesDaysWindow || 2;
      const windowDateUTC = new Date(todayDateUTC.getTime() - daysWindow * 24 * 60 * 60 * 1000);
      const windowDateStr = tz.toDateStr(windowDateUTC);

      // 4. Recalcular ventas abiertas no consolidadas desde BD con agregación directa
      const openSales = await this.fetchOpenSales(vendedorId, windowDateStr);

      const openPairs: string[] = [];
      let totalOpen = 0;
      for (const row of openSales) {
        const val = parseFloat(String(row.netAmount)) || 0;
        if (val > 0) {
          openPairs.push(row.sorteoId, val.toString());
          totalOpen += val;
        }
      }

      const projected = Math.round((baseBalance + totalOpen) * 100) / 100;
      const percentage = limit && limit > 0
        ? Math.round(((projected / limit) * 100) * 100) / 100
        : 0;
      const newStatus = this.computeCreditStatus(projected, limit, threshold, blockMode);

      // 5. Reemplazo atómico en Redis mediante script Lua (evita gap entre DEL y HSET)
      const pairCount = openPairs.length / 2;
      const oldStatus = (await redis.eval(
        ATOMIC_UPDATE_BASE_AND_OPEN_LUA,
        3,
        base,
        open,
        cfg,
        baseBalance.toString(),
        pairCount.toString(),
        newStatus,
        DEFAULT_TTL_SECONDS.toString(),
        ...openPairs
      )) as CreditStatus;

      // Emitir evento si hubo transición de estado O si se liberó de un estado de bloqueo/alerta
      const wasRestricted = oldStatus === "BLOCKED" || oldStatus === "WARNING" || oldStatus === "EXCEEDED_ALERT_ONLY";
      const isLiberated = wasRestricted && (newStatus === "NORMAL" || (oldStatus === "BLOCKED" && newStatus === "WARNING"));

      if (newStatus !== oldStatus || isLiberated) {
        await this.emitCreditStatusChanged(vendedorId, projected, percentage, newStatus);
      }

      logger.info({
        layer: "credit",
        action: "BASE_BALANCE_REFRESHED",
        payload: { vendedorId, baseBalance, totalOpen, projected, oldStatus, newStatus },
      });
    } catch (err: any) {
      markRedisError("VendorCreditService.updateBaseBalance");
      logger.error({
        layer: "credit",
        action: "UPDATE_BASE_BALANCE_ERROR",
        payload: { vendedorId, error: err?.message || String(err) },
      });
    }
  }

  /**
   * Reconcilia un sorteo evaluado: invoca updateBaseBalance para cada vendedor con tickets
   * en el sorteo Y con creditLimit configurado (>0). Los vendedores sin tope no se tocan.
   * Se ejecuta de forma cooperativa sin bloquear el Event Loop.
   */
  static async reconcileSorteo(sorteoId: string): Promise<void> {
    if (!config.creditLimit.enabled) return;

    try {
      // 1. Desmarcar de evaluación para que fetchOpenSales ya no sume este sorteo como venta abierta
      await this.unmarkSorteoEvaluating(sorteoId).catch(() => {});

      // 2. Filtrar únicamente vendedores que tengan límite de crédito asignado
      const vendorTickets = await prisma.ticket.findMany({
        where: {
          sorteoId,
          status: { notIn: ["CANCELLED", "EXCLUDED"] },
          isActive: true,
          deletedAt: null,
          vendedor: {
            creditLimit: { not: null, gt: 0 },
          },
        },
        select: { vendedorId: true },
        distinct: ["vendedorId"],
      });

      const vendorIds = vendorTickets.map((t) => t.vendedorId).filter(Boolean) as string[];

      for (const vendedorId of vendorIds) {
        // Ceder el loop cooperativamente entre vendedores
        await new Promise((resolve) => setImmediate(resolve));
        await this.updateBaseBalance(vendedorId);
      }
    } catch (err: any) {
      logger.error({
        layer: "credit",
        action: "RECONCILE_SORTEO_ERROR",
        payload: { sorteoId, error: err?.message || String(err) },
      });
    } finally {
      await this.unmarkSorteoEvaluating(sorteoId).catch(() => {});
    }
  }

  /**
   * Gancho invocado cuando un sorteo evaluado es revertido.
   * Se ejecuta DESPUÉS de que termine la sincronización contable de la reversión.
   * Aplica únicamente a vendedores con creditLimit configurado (>0).
   */
  static async onSorteoReverted(sorteoId: string): Promise<void> {
    if (!config.creditLimit.enabled) return;

    try {
      const vendorTickets = await prisma.ticket.findMany({
        where: {
          sorteoId,
          status: { notIn: ["CANCELLED", "EXCLUDED"] },
          isActive: true,
          deletedAt: null,
          vendedor: {
            creditLimit: { not: null, gt: 0 },
          },
        },
        select: { vendedorId: true },
        distinct: ["vendedorId"],
      });

      const vendorIds = vendorTickets.map((t) => t.vendedorId).filter(Boolean) as string[];

      for (const vendedorId of vendorIds) {
        await new Promise((resolve) => setImmediate(resolve));
        await this.updateBaseBalance(vendedorId);
      }
    } catch (err: any) {
      logger.error({
        layer: "credit",
        action: "ON_SORTEO_REVERTED_ERROR",
        payload: { sorteoId, error: err?.message || String(err) },
      });
    } finally {
      await this.unmarkSorteoEvaluating(sorteoId).catch(() => {});
    }
  }

  /**
   * Precalentamiento de caché (Warmup):
   * Hidrata en Redis a todos los vendedores activos que poseen un creditLimit configurado,
   * garantizando que la primera venta del día no deba pagar la latencia de hidratación.
   */
  static async warmupCaches(): Promise<void> {
    if (!config.creditLimit.enabled || !isRedisAvailable()) return;

    try {
      const vendors = await prisma.user.findMany({
        where: {
          role: Role.VENDEDOR,
          isActive: true,
          creditLimit: { not: null, gt: 0 },
        },
        select: { id: true },
      });

      logger.info({
        layer: "credit",
        action: "CREDIT_WARMUP_START",
        payload: { vendorCount: vendors.length },
      });

      // Procesar vendedores en batches de 3 con delay entre batches para no saturar BD ni Event Loop
      const CHUNK_SIZE = 3;
      const CHUNK_DELAY_MS = 50;

      for (let i = 0; i < vendors.length; i += CHUNK_SIZE) {
        const chunk = vendors.slice(i, i + CHUNK_SIZE);
        await Promise.all(
          chunk.map((v) =>
            this.hydrate(v.id).catch((err) => {
              logger.warn({
                layer: "credit",
                action: "CREDIT_WARMUP_VENDOR_ERROR",
                payload: { vendedorId: v.id, error: err?.message || String(err) },
              });
            })
          )
        );
        if (i + CHUNK_SIZE < vendors.length) {
          await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
        }
      }

      logger.info({
        layer: "credit",
        action: "CREDIT_WARMUP_COMPLETED",
        payload: { vendorCount: vendors.length },
      });
    } catch (err: any) {
      logger.error({
        layer: "credit",
        action: "CREDIT_WARMUP_ERROR",
        payload: { error: err?.message || String(err) },
      });
    }
  }

  /**
   * Invalida las claves de Redis de un vendedor para forzar rehidratación limpia en la siguiente venta.
   */
  static async invalidateKeys(vendedorId: string): Promise<void> {
    if (!isRedisAvailable()) return;

    const redis = getRedisClient();
    if (!redis) return;

    const { cfg, base, open } = this.getKeys(vendedorId);
    try {
      await redis.del(cfg, base, open);
    } catch (err: any) {
      markRedisError("VendorCreditService.invalidateKeys");
      logger.error({
        layer: "credit",
        action: "INVALIDATE_KEYS_ERROR",
        payload: { vendedorId, error: err?.message || String(err) },
      });
      throw err;
    }
  }

  /**
   * Maneja el cambio de configuración de crédito de un vendedor (tope, umbral, modo de bloqueo).
   * Actualiza 'cfg' en caliente mediante hset y recalcula el status sin purgar 'open_by_sorteo'.
   * Emite el evento WebSocket vendor:credit_status_changed al usuario correspondiente.
   */
  static async handleCreditConfigChanged(
    vendedorId: string,
    oldConfig: {
      creditLimit?: number | null;
      creditAlertThreshold?: number | null;
      creditBlockMode?: boolean | null;
    }
  ): Promise<void> {
    if (!config.creditLimit.enabled) return;

    // 1. Obtener la nueva configuración del vendedor desde BD
    const vendor = await prisma.user.findUnique({
      where: { id: vendedorId },
      select: {
        id: true,
        creditLimit: true,
        creditAlertThreshold: true,
        creditBlockMode: true,
        isActive: true,
        updatedAt: true,
        ventanaId: true,
        bancaId: true,
        ventana: { select: { bancaId: true } },
      },
    });

    if (!vendor) return;

    // Si el usuario ya no está activo, invalidar claves y salir
    if (!vendor.isActive) {
      await this.invalidateKeys(vendedorId);
      this.listScopeCache.clear();
      return;
    }

    const { cfg, base, open } = this.getKeys(vendedorId);
    const redis = getRedisClient();
    const effectiveBancaId = vendor.bancaId || vendor.ventana?.bancaId || null;
    const limit = vendor.creditLimit ?? null;
    const threshold = vendor.creditAlertThreshold ?? 80;
    const blockMode = vendor.creditBlockMode ?? true;
    const vendorUpdatedAt = vendor.updatedAt ? vendor.updatedAt.toISOString() : new Date().toISOString();

    let newEffective = 0;
    let newPercentage = 0;
    let newStatus: CreditStatus = "NORMAL";

    if (redis && isRedisAvailable()) {
      try {
        const [baseVal, openSalesMap] = await Promise.all([
          redis.get(base),
          redis.hgetall(open),
        ]);

        const previouslyHadLimit = oldConfig.creditLimit !== null && oldConfig.creditLimit !== undefined && oldConfig.creditLimit > 0;
        const currentlyHasLimit = limit !== null && limit > 0;

        if (baseVal !== null && previouslyHadLimit && currentlyHasLimit) {
          // Redis está caliente y ambos límites son positivos: actualizar cfg en caliente conservando open_by_sorteo
          const b = parseFloat(baseVal || "0") || 0;
          const openSum = Object.values(openSalesMap || {}).reduce(
            (acc, v) => acc + (parseFloat(v as string) || 0),
            0
          );
          newEffective = Math.round((b + openSum) * 100) / 100;
          newPercentage = limit && limit > 0
            ? Math.round(((newEffective / limit) * 100) * 100) / 100
            : 0;
          newStatus = this.computeCreditStatus(newEffective, limit, threshold, blockMode);

          await redis.hset(cfg, {
            limit: limit !== null ? limit.toString() : "-1",
            threshold: threshold.toString(),
            blockMode: blockMode ? "1" : "0",
            status: newStatus,
            bancaId: effectiveBancaId || "",
            ventanaId: vendor.ventanaId || "",
            isActive: "1",
            updatedAt: vendorUpdatedAt,
          });
          await redis.expire(cfg, DEFAULT_TTL_SECONDS);

          this.listScopeCache.clear();

          await this.emitCreditStatusChanged(
            vendedorId,
            newEffective,
            newPercentage,
            newStatus,
            { limit, bancaId: effectiveBancaId, ventanaId: vendor.ventanaId }
          );
          return;
        }
      } catch (err: any) {
        logger.warn({
          layer: "credit",
          action: "UPDATE_CFG_HOT_WARN_FALLING_BACK_TO_HYDRATE",
          payload: { vendedorId, error: err?.message || String(err) },
        });
      }
    }

    // Fallback: si baseVal era null o Redis falló, rehidratar normalmente
    this.listScopeCache.clear();
    let newState: HydratedCreditState;
    try {
      newState = await this.hydrate(vendedorId);
    } catch (err: any) {
      logger.error({
        layer: "credit",
        action: "REHYDRATE_AFTER_CONFIG_CHANGE_ERROR",
        payload: { vendedorId, error: err?.message || String(err) },
      });
      return;
    }

    newEffective =
      newState.baseBalance +
      Object.values(newState.openBySorteo).reduce((acc, v) => acc + v, 0);
    newPercentage =
      newState.limit && newState.limit > 0
        ? Math.round(((newEffective / newState.limit) * 100) * 100) / 100
        : 0;
    newStatus = newState.status;

    await this.emitCreditStatusChanged(
      vendedorId,
      newEffective,
      newPercentage,
      newStatus,
      { limit: newState.limit, bancaId: newState.bancaId, ventanaId: newState.ventanaId }
    );
  }

  /**
   * Consulta el estado de crédito para un listado de vendedores o para todos los del alcance del usuario.
   * Aplica aislamiento estricto por rol (RBAC), caché en memoria (2.5s) y concurrencia controlada en hidratación.
   */
  static async getVendorsCreditStatus(
    actor: { id: string; role: Role; bancaId?: string | null; ventanaId?: string | null },
    options: { activeBancaId?: string | null; requestedVendedorIds?: string[] } = {}
  ): Promise<CreditStatusResponse> {
    if (!config.creditLimit.enabled) {
      return { enabled: false, items: [] };
    }

    const { activeBancaId, requestedVendedorIds } = options;
    const isSpecificList = Array.isArray(requestedVendedorIds) && requestedVendedorIds.length > 0;

    // OPTIMIZACIÓN REDIS-FIRST (Caso mono-ID, ej: /api/v1/credit/status/me)
    if (isSpecificList && requestedVendedorIds.length === 1) {
      const targetId = requestedVendedorIds[0];

      // Validación preliminar RBAC para VENDEDOR (solo puede consultar su propio ID)
      if (actor.role === Role.VENDEDOR && targetId !== actor.id) {
        return { enabled: true, items: [] };
      }

      const redis = getRedisClient();
      if (redis && isRedisAvailable()) {
        try {
          const { cfg, base, open } = this.getKeys(targetId);
          const pipeline = redis.pipeline();
          pipeline.hgetall(cfg);
          pipeline.get(base);
          pipeline.hgetall(open);
          const results = await pipeline.exec();

          const cfgMap = (results?.[0]?.[1] as Record<string, string>) || {};
          const baseVal = results?.[1]?.[1] as string | null | undefined;
          const openMap = (results?.[2]?.[1] as Record<string, string>) || {};

          // Si el hash cfg y el base existen en Redis (cache hit)
          if (
            cfgMap &&
            Object.keys(cfgMap).length > 0 &&
            cfgMap.limit !== undefined &&
            baseVal !== null &&
            baseVal !== undefined
          ) {
            // Si el vendedor fue marcado inactivo en Redis, retornar vacío
            if (cfgMap.isActive === "0") {
              return { enabled: true, items: [] };
            }

            // Validar RBAC según relaciones en cfgMap
            if (actor.role === Role.VENTANA && cfgMap.ventanaId && cfgMap.ventanaId !== actor.ventanaId) {
              return { enabled: true, items: [] };
            }
            if (actor.role === Role.ADMIN && activeBancaId && cfgMap.bancaId && cfgMap.bancaId !== activeBancaId) {
              return { enabled: true, items: [] };
            }

            const canServeBanca =
              actor.role !== Role.BANCA ||
              (actor.bancaId && cfgMap.bancaId === actor.bancaId);

            if (canServeBanca) {
              const rawLimit = parseFloat(cfgMap.limit);
              const limit = !isNaN(rawLimit) && rawLimit > 0 ? rawLimit : null;
              const threshold = parseFloat(cfgMap.threshold) || 80;
              const blockMode = cfgMap.blockMode !== "0";

              const baseNum = parseFloat(baseVal || "0") || 0;
              const openTotal = Object.values(openMap || {}).reduce(
                (acc: number, val: any) => acc + (parseFloat(val) || 0),
                0
              );
              const effectiveBalance = Math.round((baseNum + openTotal) * 100) / 100;
              const percentageUsed =
                limit && limit > 0
                  ? Math.round(((effectiveBalance / limit) * 100) * 100) / 100
                  : 0;

              const status = this.computeCreditStatus(effectiveBalance, limit, threshold, blockMode);
              const updatedAt = cfgMap.updatedAt || new Date().toISOString();

              return {
                enabled: true,
                items: [
                  {
                    vendedorId: targetId,
                    creditLimit: limit,
                    effectiveBalance,
                    percentageUsed,
                    status,
                    updatedAt,
                  },
                ],
              };
            }
          }
        } catch (err: any) {
          logger.warn({
            layer: "credit",
            action: "GET_VENDOR_CREDIT_STATUS_REDIS_FIRST_WARN",
            payload: { targetId, error: err?.message || String(err) },
          });
        }
      }
    }

    // Si es consulta general por alcance (sin IDs específicos), verificar caché en memoria (2.5s)
    let cacheKey = "";
    if (!isSpecificList) {
      cacheKey = `${actor.role}:${actor.id}:${activeBancaId || ""}:${actor.ventanaId || ""}`;
      const cached = this.listScopeCache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        return cached.data;
      }
    }

    // 1. Resolver alcance según el rol del actor
    let targetVendors: Array<{
      id: string;
      creditLimit: number | null;
      creditAlertThreshold: number | null;
      creditBlockMode: boolean | null;
      updatedAt: Date;
    }> = [];

    let isTruncated = false;

    if (isSpecificList) {
      const uniqueIds = Array.from(new Set(requestedVendedorIds)).slice(0, 200);

      // Filtrar según el alcance del rol
      const whereClause: any = {
        id: { in: uniqueIds },
        role: Role.VENDEDOR,
        isActive: true,
      };

      if (actor.role === Role.VENDEDOR) {
        whereClause.id = actor.id;
      } else if (actor.role === Role.VENTANA) {
        whereClause.ventanaId = actor.ventanaId;
      } else if (actor.role === Role.BANCA) {
        const assignedBancaIds = await prisma.userBanca.findMany({
          where: { userId: actor.id },
          select: { bancaId: true },
        }).then((rows: any[]) => rows.map((r: any) => r.bancaId));
        if (actor.bancaId && !assignedBancaIds.includes(actor.bancaId)) {
          assignedBancaIds.push(actor.bancaId);
        }
        whereClause.ventana = { bancaId: { in: assignedBancaIds } };
      } else if (actor.role === Role.ADMIN) {
        if (activeBancaId) {
          whereClause.ventana = { bancaId: activeBancaId };
        }
      }

      targetVendors = await prisma.user.findMany({
        where: whereClause,
        select: {
          id: true,
          creditLimit: true,
          creditAlertThreshold: true,
          creditBlockMode: true,
          updatedAt: true,
        },
      });
    } else {
      // Listado general por alcance: Solo vendedores con tope configurado (>0), máximo 500
      const whereClause: any = {
        role: Role.VENDEDOR,
        isActive: true,
        creditLimit: { not: null, gt: 0 },
      };

      if (actor.role === Role.VENDEDOR) {
        whereClause.id = actor.id;
      } else if (actor.role === Role.VENTANA) {
        whereClause.ventanaId = actor.ventanaId;
      } else if (actor.role === Role.BANCA) {
        const assignedBancaIds = await prisma.userBanca.findMany({
          where: { userId: actor.id },
          select: { bancaId: true },
        }).then((rows: any[]) => rows.map((r: any) => r.bancaId));
        if (actor.bancaId && !assignedBancaIds.includes(actor.bancaId)) {
          assignedBancaIds.push(actor.bancaId);
        }
        whereClause.ventana = { bancaId: { in: assignedBancaIds } };
      } else if (actor.role === Role.ADMIN) {
        if (activeBancaId) {
          whereClause.ventana = { bancaId: activeBancaId };
        }
      }

      const rows = await prisma.user.findMany({
        where: whereClause,
        take: 501,
        select: {
          id: true,
          creditLimit: true,
          creditAlertThreshold: true,
          creditBlockMode: true,
          updatedAt: true,
        },
      });

      if (rows.length > 500) {
        isTruncated = true;
        targetVendors = rows.slice(0, 500);
      } else {
        targetVendors = rows;
      }
    }

    // 2. Obtener estado de crédito para cada vendedor
    // Leemos de Redis. Si alguna clave no está hidratada, la hidratamos con concurrencia controlada (máx 3 a la vez)
    const redis = getRedisClient();
    const items: CreditStatusItem[] = [];
    const toHydrate: Array<typeof targetVendors[0]> = [];

    if (redis && isRedisAvailable()) {
      for (const v of targetVendors) {
        const { base, open } = this.getKeys(v.id);
        const [baseVal, openMap] = await Promise.all([
          redis.get(base),
          redis.hgetall(open),
        ]);

        if (baseVal === null) {
          toHydrate.push(v);
        } else {
          const baseNum = parseFloat(baseVal) || 0;
          const openTotal = Object.values(openMap || {}).reduce(
            (acc: number, val: any) => acc + (parseFloat(val) || 0),
            0
          );
          const effectiveBalance = Math.round((baseNum + openTotal) * 100) / 100;
          const limit = v.creditLimit && v.creditLimit > 0 ? v.creditLimit : null;
          const threshold = v.creditAlertThreshold ?? 80;
          const blockMode = v.creditBlockMode ?? true;

          const percentageUsed = limit && limit > 0
            ? Math.round(((effectiveBalance / limit) * 100) * 100) / 100
            : 0;

          const status = this.computeCreditStatus(effectiveBalance, limit, threshold, blockMode);

          items.push({
            vendedorId: v.id,
            creditLimit: limit,
            effectiveBalance,
            percentageUsed,
            status,
            updatedAt: v.updatedAt.toISOString(),
          });
        }
      }
    } else {
      toHydrate.push(...targetVendors);
    }

    // Hidratar con concurrencia limitada (máx 3 a la vez) para no saturar el pool de PostgreSQL
    if (toHydrate.length > 0) {
      const CONCURRENCY_LIMIT = 3;
      for (let i = 0; i < toHydrate.length; i += CONCURRENCY_LIMIT) {
        const batch = toHydrate.slice(i, i + CONCURRENCY_LIMIT);
        const hydratedBatch = await Promise.all(
          batch.map(async (v) => {
            const h = await this.hydrate(v.id);
            const totalOpen = Object.values(h.openBySorteo).reduce((a: number, b: any) => a + (parseFloat(b) || 0), 0);
            const effectiveBalance = Math.round((h.baseBalance + totalOpen) * 100) / 100;
            const limit = v.creditLimit && v.creditLimit > 0 ? v.creditLimit : null;
            const threshold = v.creditAlertThreshold ?? 80;
            const blockMode = v.creditBlockMode ?? true;
            const percentageUsed = limit && limit > 0
              ? Math.round(((effectiveBalance / limit) * 100) * 100) / 100
              : 0;
            const status = this.computeCreditStatus(effectiveBalance, limit, threshold, blockMode);
            return {
              vendedorId: v.id,
              creditLimit: limit,
              effectiveBalance,
              percentageUsed,
              status,
              updatedAt: v.updatedAt.toISOString(),
            };
          })
        );
        items.push(...hydratedBatch);
      }
    }

    const response: CreditStatusResponse = {
      enabled: true,
      items,
      ...(isTruncated ? { truncated: true } : {}),
    };

    if (!isSpecificList && cacheKey) {
      this.listScopeCache.set(cacheKey, {
        data: response,
        expiresAt: Date.now() + 2500, // 2.5 segundos
      });
    }

    return response;
  }

  /**
   * Emite el evento WebSocket vendor:credit_status_changed con el nuevo esquema requerido.
   */
  private static async emitCreditStatusChanged(
    vendedorId: string,
    effectiveBalance: number,
    percentageUsed: number,
    status: CreditStatus,
    extra?: { limit?: number | null; bancaId?: string | null; ventanaId?: string | null }
  ): Promise<void> {
    try {
      if (status === "BLOCKED") {
        const now = Date.now();
        const lastEmit = this.lastBlockedEmitTime.get(vendedorId) || 0;
        if (now - lastEmit < this.BLOCKED_DEBOUNCE_MS) {
          // Debounce para evitar spam de eventos BLOCKED repetidos
          return;
        }
        this.lastBlockedEmitTime.set(vendedorId, now);
      } else {
        this.lastBlockedEmitTime.delete(vendedorId);
      }

      const { cfg } = this.getKeys(vendedorId);
      const redis = getRedisClient();
      let limit: number | null = extra?.limit ?? null;
      let bancaId: string | null = extra?.bancaId ?? null;
      let ventanaId: string | null = extra?.ventanaId ?? null;

      if ((limit === null || bancaId === null || ventanaId === null) && redis && isRedisAvailable()) {
        const [l, b, v] = await redis.hmget(cfg, "limit", "bancaId", "ventanaId");
        if (limit === null && l && l !== "-1") limit = parseFloat(l);
        if (bancaId === null) bancaId = b || null;
        if (ventanaId === null) ventanaId = v || null;
      }

      SocketService.notifyVendorCreditStatusChanged({
        vendedorId,
        bancaId,
        ventanaId,
        creditLimit: limit,
        effectiveBalance: Math.round(effectiveBalance * 100) / 100,
        percentageUsed: Math.round(percentageUsed * 100) / 100,
        status,
        updatedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      logger.warn({
        layer: "credit",
        action: "EMIT_CREDIT_STATUS_ERROR",
        payload: { vendedorId, error: err?.message || String(err) },
      });
    }
  }
}

export default VendorCreditService;
