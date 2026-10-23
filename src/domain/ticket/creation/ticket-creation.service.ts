import { ActivityType, Role } from "../../../generated/prisma/client";
import { withConnectionRetry } from "../../../core/withConnectionRetry";
import ActivityService from "../../../core/activity.service";
import logger from "../../../core/logger";
import { AppError } from "../../../core/errors";
import { salesPrisma, salesPool, generalPool } from "../../../core/prismaClient";
import { config } from "../../../config";
import { RestrictionRuleRepository } from "../../../repositories/restrictionRule.repository";
import { TicketRiskValidator } from "../pipeline/TicketRiskValidator";
import { TicketPrefetchService } from "../pipeline/TicketPrefetchService";
import TicketRepository, { resolveBaseMultiplierX } from "../../../repositories/ticket.repository";
import { TicketTimingCollector } from "../pipeline/ticket.types";
import { commissionService } from "../../../domain/commission/CommissionService";
import { nowCR, validateDate, normalizeDateCR } from "../../../utils/datetime";
import { CacheService } from "../../../core/cache.service";
import { TicketValidationService } from "../TicketValidationService";
import { TicketPrintService } from "../TicketPrintService";
import { TicketPersistenceService } from "../TicketPersistenceService";
import { RestrictionRuleService } from "../../restriction/restrictionRule.service";

const CUTOFF_GRACE_MS = 1000;
const L1_TTL_ENTITY_MS = 300_000;

export async function resolveEffectiveActor(
  actor: any,
  requestedVendedorId: string | undefined,
  prefetchedTarget?: any,
): Promise<{
  effectiveVendedorId: string;
  ventanaId: string;
  vendedorToPass: any;
}> {
  let effectiveVendedorId: string;
  let ventanaId: string;
  let vendedorToPass: any = actor;

  if (requestedVendedorId && requestedVendedorId !== actor.id) {
    if (
      actor.role !== Role.VENDEDOR &&
      actor.role !== Role.ADMIN &&
      actor.role !== Role.VENTANA
    ) {
      throw new AppError("No tienes permisos para realizar esta acción", 403);
    }

    const target =
      prefetchedTarget ||
      (await CacheService.wrap(
        `user:${requestedVendedorId}`,
        () =>
          withConnectionRetry(
            () =>
              salesPrisma.user.findUnique({
                where: { id: requestedVendedorId },
                select: {
                  id: true,
                  role: true,
                  ventanaId: true,
                  isActive: true,
                  commissionPolicyJson: true,
                  name: true,
                  code: true,
                  phone: true,
                  settings: true,
                  creditLimit: true,
                  creditAlertThreshold: true,
                  creditBlockMode: true,
                },
              }),
            { context: "TicketCreationService.create.targetVendedor" },
          ),
        3600,
        [`user:${requestedVendedorId}`],
      ));
    if (!target || !target.isActive)
      throw new AppError("Vendedor no encontrado o inactivo", 404);
    if (target.role !== Role.VENDEDOR)
      throw new AppError(
        "vendedorId debe pertenecer a un usuario con rol VENDEDOR",
        400,
      );
    if (!target.ventanaId)
      throw new AppError(
        "El vendedor seleccionado no tiene Ventana asignada",
        400,
      );

    if (actor.role === Role.VENTANA) {
      if (!actor.ventanaId || actor.ventanaId !== target.ventanaId) {
        throw new AppError("vendedorId no pertenece a tu Ventana", 403);
      }
    }

    effectiveVendedorId = target.id;
    ventanaId = target.ventanaId;
    vendedorToPass = target;
  } else {
    if (actor.role === Role.VENDEDOR) {
      if (!actor.ventanaId)
        throw new AppError("El vendedor no tiene una Ventana asignada", 400);
      effectiveVendedorId = actor.id;
      ventanaId = actor.ventanaId;
      vendedorToPass = actor;
    } else {
      throw new AppError("vendedorId es requerido para este rol", 400);
    }
  }

  return { effectiveVendedorId, ventanaId, vendedorToPass };
}

export class TicketCreationService {
  /**
   * Orquestación de creación de ticket (validación, riesgo, comisión, persistencia)
   */
  static async create(
    data: any,
    userId: string,
    requestId?: string,
    actorRole: Role = Role.VENDEDOR,
    userVentanaId?: string | null,
  ) {
    try {
      const t0 = performance.now();
      const initialPoolStats = {
        sales_pool_waiting: salesPool.waitingCount,
        sales_pool_total: salesPool.totalCount,
        sales_pool_idle: salesPool.idleCount,
        general_pool_waiting: generalPool.waitingCount,
      };
      const timingCollector: TicketTimingCollector = {
        startTime: t0,
        initialPoolStats,
        prefetch_breakdown: {},
      };

      const { loteriaId, sorteoId } = data;
      if (!loteriaId || !sorteoId)
        throw new AppError("Missing loteriaId/sorteoId", 400);

      const clientIdempotencyKey: string | undefined =
        data.idempotencyKey ?? data.requestId;

      const initialVentanaId = data.ventanaId ?? userVentanaId ?? undefined;
      const requestedVendedorId = data.vendedorId;

      // 1. Master Promise.all (Fase 1): Carga paralela de todas las entidades independientes
      const t_core_start = performance.now();
      const [actor, sorteo, ventanaWithBanca, targetVendedor] =
        await Promise.all([
          CacheService.wrap(
            `user:${userId}`,
            () =>
              withConnectionRetry(
                () =>
                  salesPrisma.user.findUnique({
                    where: { id: userId },
                    select: {
                      id: true,
                      role: true,
                      ventanaId: true,
                      isActive: true,
                      commissionPolicyJson: true,
                      name: true,
                      code: true,
                      phone: true,
                      settings: true,
                      creditLimit: true,
                      creditAlertThreshold: true,
                      creditBlockMode: true,
                    },
                  }),
                { context: "TicketCreationService.create.actor" },
              ),
            86400,
            [`user:${userId}`],
            true,
            L1_TTL_ENTITY_MS,
          ),
          CacheService.wrap(
            `sorteo:${sorteoId}`,
            () =>
              withConnectionRetry(
                () =>
                  salesPrisma.sorteo.findUnique({
                    where: { id: sorteoId },
                    select: {
                      id: true,
                      name: true,
                      scheduledAt: true,
                      status: true,
                      loteriaId: true,
                      bancaId: true,
                      loteria: {
                        select: { id: true, name: true, rulesJson: true },
                      },
                    },
                  }),
                { context: "TicketCreationService.create.sorteo" },
              ),
            86400,
            [`sorteo:${sorteoId}`],
            true,
            L1_TTL_ENTITY_MS,
          ),
          initialVentanaId
            ? CacheService.wrap(
                `ventana:${initialVentanaId}`,
                () =>
                  withConnectionRetry(
                    () =>
                      salesPrisma.ventana.findUnique({
                        where: { id: initialVentanaId },
                        select: {
                          id: true,
                          bancaId: true,
                          isActive: true,
                          commissionPolicyJson: true,
                          name: true,
                          code: true,
                          phone: true,
                          settings: true,
                          banca: {
                            select: { id: true, commissionPolicyJson: true },
                          },
                        },
                      }),
                    { context: "TicketCreationService.create.ventana" },
                  ),
                86400,
                [`ventana:${initialVentanaId}`],
                true,
                L1_TTL_ENTITY_MS,
              )
            : Promise.resolve(null),
          requestedVendedorId && requestedVendedorId !== userId
            ? CacheService.wrap(
                `user:${requestedVendedorId}`,
                () =>
                  withConnectionRetry(
                    () =>
                      salesPrisma.user.findUnique({
                        where: { id: requestedVendedorId },
                        select: {
                          id: true,
                          role: true,
                          ventanaId: true,
                          isActive: true,
                          commissionPolicyJson: true,
                          name: true,
                          code: true,
                          phone: true,
                          settings: true,
                          creditLimit: true,
                          creditAlertThreshold: true,
                          creditBlockMode: true,
                        },
                      }),
                    { context: "TicketCreationService.create.targetVendedor" },
                  ),
                86400,
                [`user:${requestedVendedorId}`],
                true,
                L1_TTL_ENTITY_MS,
              )
            : Promise.resolve(null),
        ]);

      try {
        if (timingCollector.prefetch_breakdown) {
          timingCollector.prefetch_breakdown.t_actor =
            Math.round((performance.now() - t_core_start) * 100) / 100;
          timingCollector.prefetch_breakdown.t_core_entities = 0.01;
        }
      } catch {}

      if (!actor) throw new AppError("Authenticated user not found", 401);
      if (!sorteo) throw new AppError("Sorteo no encontrado", 404);

      // 2. Resolver Vendedor y Ventana
      const t_eff_start = performance.now();
      const { effectiveVendedorId, ventanaId, vendedorToPass } =
        await resolveEffectiveActor(actor, requestedVendedorId, targetVendedor);
      try {
        if (timingCollector.prefetch_breakdown) {
          timingCollector.prefetch_breakdown.t_effective_actor =
            Math.round((performance.now() - t_eff_start) * 100) / 100;
        }
      } catch {}

      let resolvedVentanaWithBanca = ventanaWithBanca;

      if (
        !resolvedVentanaWithBanca ||
        resolvedVentanaWithBanca.id !== ventanaId
      ) {
        const t_fallback_start = performance.now();
        resolvedVentanaWithBanca = await CacheService.wrap(
          `ventana:${ventanaId}`,
          () =>
            withConnectionRetry(
              () =>
                salesPrisma.ventana.findUnique({
                  where: { id: ventanaId },
                  select: {
                    id: true,
                    bancaId: true,
                    isActive: true,
                    commissionPolicyJson: true,
                    name: true,
                    code: true,
                    phone: true,
                    settings: true,
                    banca: {
                      select: { id: true, commissionPolicyJson: true },
                    },
                  },
                }),
              { context: "TicketCreationService.create.ventana" },
            ),
          86400,
          [`ventana:${ventanaId}`],
          true,
          L1_TTL_ENTITY_MS,
        );
        try {
          if (timingCollector.prefetch_breakdown) {
            timingCollector.prefetch_breakdown.t_resolved_ventana =
              Math.round((performance.now() - t_fallback_start) * 100) / 100;
          }
        } catch {}
      } else {
        try {
          if (timingCollector.prefetch_breakdown) {
            timingCollector.prefetch_breakdown.t_resolved_ventana = 0;
          }
        } catch {}
      }

      if (sorteo.scheduledAt) {
        sorteo.scheduledAt = normalizeDateCR(
          sorteo.scheduledAt,
          "sorteo.scheduledAt",
        );
      }
      if (sorteo.status === "CLOSED")
        throw new AppError(
          "No se pueden crear tickets en un sorteo cerrado",
          409,
        );
      if (loteriaId !== sorteo.loteriaId) {
        throw new AppError(
          `loteriaId mismatch: request=${loteriaId}, sorteo=${sorteo.loteriaId}`,
          400,
        );
      }
      if (!resolvedVentanaWithBanca || !resolvedVentanaWithBanca.isActive)
        throw new AppError("La Ventana no existe o está inactiva", 404);

      if (
        sorteo.bancaId &&
        sorteo.bancaId !== resolvedVentanaWithBanca.bancaId
      ) {
        throw new AppError(
          "Operación denegada: El sorteo pertenece a otra banca",
          403,
          "CROSS_TENANT_FORBIDDEN",
        );
      }

      try {
        validateDate(sorteo.scheduledAt, "sorteo.scheduledAt");
      } catch (err: any) {
        logger.error({
          layer: "service",
          action: "INVALID_SORTEO_SCHEDULED_AT",
          payload: { sorteoId, error: err.message },
        });
        throw new AppError(`Sorteo ${sorteoId} con fecha inválida`, 400);
      }

      // 3. Master Promise.all (Fase 2): Carga paralela de reglas de negocio, multiplicadores, cutoff y reglas de riesgo
      let t_cutoff_ms = 0;
      let t_rules_ms = 0;
      let t_multipliers_ms = 0;
      let t_base_multiplier_ms = 0;

      const [
        cutoff,
        preFetchedRules,
        preFetchedMultipliers,
        preFetchedBaseMultiplier,
      ] = await Promise.all([
        (async () => {
          const t0 = performance.now();
          const res = await RestrictionRuleRepository.resolveSalesCutoff({
            bancaId: resolvedVentanaWithBanca.bancaId,
            ventanaId,
            userId: effectiveVendedorId,
            defaultCutoff: 1,
            client: salesPrisma,
          });
          t_cutoff_ms = Math.round((performance.now() - t0) * 100) / 100;
          return res;
        })(),
        (async () => {
          const t0 = performance.now();
          const res = await TicketRiskValidator.prefetchRules({
            userId: effectiveVendedorId,
            ventanaId,
            bancaId: resolvedVentanaWithBanca.bancaId,
          });
          t_rules_ms = Math.round((performance.now() - t0) * 100) / 100;
          return res;
        })(),
        (async () => {
          const t0 = performance.now();
          const res = await TicketPrefetchService.fetchMultipliersIfNeeded(
            data.jugadas,
            undefined,
            loteriaId,
          );
          t_multipliers_ms = Math.round((performance.now() - t0) * 100) / 100;
          return res;
        })(),
        (async () => {
          const t0 = performance.now();
          const res = await resolveBaseMultiplierX(salesPrisma as any, {
            bancaId: resolvedVentanaWithBanca.bancaId,
            loteriaId,
            userId: effectiveVendedorId,
            ventanaId,
          });
          t_base_multiplier_ms = Math.round((performance.now() - t0) * 100) / 100;
          return res;
        })(),
      ]);

      try {
        if (timingCollector.prefetch_breakdown) {
          timingCollector.prefetch_breakdown.t_cutoff = t_cutoff_ms;
          timingCollector.prefetch_breakdown.t_rules = t_rules_ms;
          timingCollector.prefetch_breakdown.t_multipliers = t_multipliers_ms;
          timingCollector.prefetch_breakdown.t_pre_tx_meta = t_base_multiplier_ms;
        }
      } catch {}

      const now = nowCR();
      const safeMinutes =
        typeof cutoff.minutes === "number" && !isNaN(cutoff.minutes)
          ? cutoff.minutes
          : 1;
      const cutoffMs = safeMinutes * 60_000;
      const effectiveLimitTime = new Date(
        sorteo.scheduledAt.getTime() - cutoffMs + CUTOFF_GRACE_MS,
      );

      if (now >= effectiveLimitTime) {
        const minsLeft = Math.max(
          0,
          Math.ceil((sorteo.scheduledAt.getTime() - now.getTime()) / 60_000),
        );
        throw new AppError(
          `Venta bloqueada: faltan ${minsLeft} min para el sorteo`,
          409,
        );
      }

      // Procesamiento de jugadas
      const jugadasIn: any[] = Array.isArray(data.jugadas) ? data.jugadas : [];
      TicketValidationService.validateTicketRulesAndHours(
        sorteo,
        jugadasIn,
        now,
      );

      // Preparar contexto de comisiones
      const t_comm_start = performance.now();
      const commissionContext = await commissionService.prepareContext(
        effectiveVendedorId,
        ventanaId,
        resolvedVentanaWithBanca.bancaId,
        vendedorToPass?.commissionPolicyJson ?? null,
        resolvedVentanaWithBanca?.commissionPolicyJson ?? null,
        resolvedVentanaWithBanca?.banca?.commissionPolicyJson ?? null,
        null,
      );
      try {
        if (timingCollector.prefetch_breakdown) {
          timingCollector.prefetch_breakdown.t_commissions =
            Math.round((performance.now() - t_comm_start) * 100) / 100;
        }
      } catch {}

      const normalizedJugadas = jugadasIn.map((j: any) => {
        const type = (j.type ?? "NUMERO") as "NUMERO" | "REVENTADO";
        const isNumero = type === "NUMERO";
        const number = isNumero ? j.number! : (j.reventadoNumber ?? j.number)!;
        return {
          type,
          number,
          reventadoNumber: isNumero ? null : number,
          amount: j.amount,
          multiplierId: isNumero ? ((j as any).multiplierId ?? null) : null,
          finalMultiplierX: 0,
        };
      });

      let createdBy: string | undefined;
      let createdByRole: Role | undefined;

      if (effectiveVendedorId === actor.id) {
        createdBy = actor.id;
        createdByRole = Role.VENDEDOR;
      } else {
        createdBy = actor.id;
        createdByRole = actor.role;
      }

      // 4. Crear ticket
      const { ticket, warnings, creditInfo } =
        await TicketPersistenceService.createTicketOptimized(
          {
            loteriaId,
            sorteoId,
            ventanaId,
            clienteNombre: data.clienteNombre ?? null,
            jugadas: normalizedJugadas,
          },
          effectiveVendedorId,
          {
            actorRole,
            commissionContext,
            createdBy,
            createdByRole,
            scheduledAt: sorteo.scheduledAt,
            idempotencyKey: clientIdempotencyKey,
            timingCollector,
            preFetched: {
              vendedor: vendedorToPass,
              sorteo: sorteo,
              ventana: resolvedVentanaWithBanca,
              loteria: sorteo.loteria,
              rules: preFetchedRules,
              multipliers: preFetchedMultipliers,
              baseMultiplier: preFetchedBaseMultiplier,
            },
          },
          clientIdempotencyKey,
          userId,
          requestId,
        );

      CacheService.invalidateTag(`vendedor:${effectiveVendedorId}`).catch(
        (err) => {
          logger.warn({
            layer: "cache",
            action: "INVALIDATE_ERROR_ON_CREATE",
            payload: { vendedorId: effectiveVendedorId, error: err.message },
          });
        },
      );

      // 5. Construir response
      const response = TicketPrintService.buildEnrichedResponse(
        ticket,
        sorteo,
        vendedorToPass,
        resolvedVentanaWithBanca,
        effectiveVendedorId,
        ventanaId,
      );

      const jugadasList = (ticket as any).jugadas || [];
      const jugadasCount = jugadasList.length ?? jugadasIn.length;
      const jugadasSummary = jugadasList
        .map(
          (j: any) =>
            `${j.type === "REVENTADO" ? "R:" : "#"}${j.number}: ₡${j.amount.toLocaleString()}`,
        )
        .join(", ");

      ActivityService.log({
        userId,
        bancaId: resolvedVentanaWithBanca.bancaId,
        action: ActivityType.TICKET_CREATE,
        targetType: "TICKET",
        targetId: ticket.id,
        details: {
          ticketNumber: ticket.ticketNumber,
          totalAmount: ticket.totalAmount,
          jugadas: jugadasCount,
          description: `Ticket #${ticket.ticketNumber} creado por [${effectiveVendedorId}] - ${vendedorToPass?.name || "N/A"} para ${sorteo.loteria.name} - ${TicketPrintService.formatSorteoNameWithTime(sorteo.name, sorteo.scheduledAt)} por un monto de ₡${ticket.totalAmount.toLocaleString()}. Jugadas: [${jugadasSummary}]`,
        },
        requestId,
        layer: "service",
      });

      logger.info({
        layer: "service",
        action: "TICKET_CREATE",
        userId,
        requestId,
        payload: {
          ticketId: ticket.id,
          totalAmount: ticket.totalAmount,
          jugadas: jugadasCount,
        },
      });

      if (warnings && warnings.length > 0) {
        logger.warn({
          layer: "service",
          action: "TICKET_CREATE_WARNINGS",
          userId,
          requestId,
          payload: { warnings },
        });
        (response as any).warnings = warnings;
      }

      if (creditInfo) {
        (response as any).creditInfo = creditInfo;
      }

      // 5.1 Piggyback sorteoBalances: pre-calcula los balances en memoria con el acumulado recién incrementado
      // para que el cliente no tenga que disparar un GET /validation/balances redundante.
      try {
        RestrictionRuleService.invalidateVendorBalancesL1Cache(effectiveVendedorId, ticket.sorteoId);
        const sorteoBalances = await TicketRepository.getSorteoBalances({
          sorteoId: ticket.sorteoId,
          vendedorId: effectiveVendedorId,
          bancaId: resolvedVentanaWithBanca.bancaId,
          actorRole,
          bypassL1Cache: true,
        });
        if (sorteoBalances) {
          (response as any).sorteoBalances = sorteoBalances;
        }
      } catch (err: any) {
        logger.warn({
          layer: "service",
          action: "PIGGYBACK_SORTEO_BALANCES_ERROR",
          userId,
          requestId,
          payload: { ticketId: ticket.id, error: err?.message },
        });
      }

      // 6. Instrumentación y desglose de tiempos
      try {
        const t_now = performance.now();
        const t_total = Math.round((t_now - timingCollector.startTime) * 100) / 100;
        const txEndTime = timingCollector.tx_end_time ?? t_now;
        const t_post = Math.round(Math.max(0, t_now - txEndTime) * 100) / 100;
        const t_prefetch = timingCollector.t_prefetch ?? 0;
        const t_pool_wait = timingCollector.t_pool_wait ?? 0;
        const t_tx = timingCollector.t_tx ?? 0;
        const tx_attempts = timingCollector.tx_attempts ?? 1;

        const slowThreshold = config.slowTicketMs || 500;

        logger.debug({
          layer: "service",
          action: "ticket_request_timing",
          userId,
          requestId,
          payload: {
            ticketId: ticket.id,
            t_total,
          },
        });

        if (t_total > slowThreshold) {
          logger.warn({
            layer: "service",
            action: "slow_ticket_breakdown",
            userId,
            requestId,
            payload: {
              ticketId: ticket.id,
              ticketNumber: ticket.ticketNumber,
              t_total,
              t_prefetch,
              prefetch_breakdown: timingCollector.prefetch_breakdown,
              t_pool_wait,
              t_tx,
              t_post,
              tx_attempts,
              sales_pool_waiting: timingCollector.initialPoolStats.sales_pool_waiting,
              sales_pool_total: timingCollector.initialPoolStats.sales_pool_total,
              sales_pool_idle: timingCollector.initialPoolStats.sales_pool_idle,
              general_pool_waiting: timingCollector.initialPoolStats.general_pool_waiting,
            },
          });
        }
      } catch {
        // La instrumentación nunca debe lanzar excepciones ni alterar el flujo
      }

      return response;
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "TICKET_CREATE_FAIL",
        userId,
        requestId,
        payload: { message: err.message },
      });
      throw err;
    }
  }
}
