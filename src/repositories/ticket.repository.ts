import prisma from "../core/prismaClient";
import { Prisma, TicketStatus } from "@prisma/client";
import logger from "../core/logger";
import { AppError } from "../core/errors";
import { withTransactionRetry } from "../core/withTransactionRetry";
import CommissionResolver, { resolveCommissionFromPolicy } from "../services/commission/commission.resolver";
import { getBusinessDateCRInfo, getCRDayRangeUTC } from "../utils/businessDate";

type CreateTicketInput = {
  loteriaId: string;
  sorteoId: string;
  ventanaId: string;
  totalAmount?: number; // ignorado; el backend calcula el total
  clienteNombre?: string | null; // nombre del cliente (opcional)
  jugadas: Array<{
    type: "NUMERO" | "REVENTADO";
    number: string;
    reventadoNumber?: string | null; // requerido si type=REVENTADO (igual a number)
    amount: number;
    multiplierId?: string; // resuelto en repo para NUMERO; placeholder para REVENTADO
    finalMultiplierX?: number; // resuelto en repo para NUMERO; 0 para REVENTADO
  }>;
};

function isSameLocalDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Resolución de multiplicador Base (robusta + fallback)
// ────────────────────────────────────────────────────────────────────────────────

async function resolveBaseMultiplierX(
  tx: Prisma.TransactionClient,
  args: {
    bancaId: string;
    loteriaId: string;
    userId: string;
    ventanaId: string;
  }
): Promise<{ valueX: number; source: string }> {
  const { bancaId, loteriaId, userId, ventanaId } = args;

  // 0) Override por usuario (directo en X) - HIGHEST PRIORITY
  const userOverride = await tx.multiplierOverride.findFirst({
    where: {
      scope: "USER",
      userId,
      loteriaId,
      multiplierType: "NUMERO",
      isActive: true,
    },
    select: { baseMultiplierX: true },
  });
  if (typeof userOverride?.baseMultiplierX === "number") {
    return {
      valueX: userOverride.baseMultiplierX,
      source: "multiplierOverride[scope=USER]",
    };
  }

  // 0.5) Override por ventana - SECOND PRIORITY
  const ventanaOverride = await tx.multiplierOverride.findFirst({
    where: {
      scope: "VENTANA",
      ventanaId,
      loteriaId,
      multiplierType: "NUMERO",
      isActive: true,
    },
    select: { baseMultiplierX: true },
  });
  if (typeof ventanaOverride?.baseMultiplierX === "number") {
    return {
      valueX: ventanaOverride.baseMultiplierX,
      source: "multiplierOverride[scope=VENTANA]",
    };
  }

  // 1) Config por banca/lotería
  const bls = await tx.bancaLoteriaSetting.findUnique({
    where: { bancaId_loteriaId: { bancaId, loteriaId } },
    select: { baseMultiplierX: true },
  });
  if (typeof bls?.baseMultiplierX === "number") {
    return {
      valueX: bls.baseMultiplierX,
      source: "bancaLoteriaSetting.baseMultiplierX",
    };
  }

  // 2) Multiplicador de la Lotería (tabla loteriaMultiplier)
  const lmBase = await tx.loteriaMultiplier.findFirst({
    where: { loteriaId, isActive: true, name: "Base" },
    select: { valueX: true },
  });
  if (typeof lmBase?.valueX === "number" && lmBase.valueX > 0) {
    return { valueX: lmBase.valueX, source: "loteriaMultiplier[name=Base]" };
  }

  const lmNumero = await tx.loteriaMultiplier.findFirst({
    where: { loteriaId, isActive: true, kind: "NUMERO" },
    orderBy: { createdAt: "asc" },
    select: { valueX: true, name: true },
  });
  if (typeof lmNumero?.valueX === "number" && lmNumero.valueX > 0) {
    return {
      valueX: lmNumero.valueX,
      source: `loteriaMultiplier[kind=NUMERO,name=${lmNumero.name ?? ""}]`,
    };
  }

  // 3) Fallback: rulesJson en Lotería
  const lot = await tx.loteria.findUnique({
    where: { id: loteriaId },
    select: { rulesJson: true },
  });
  const rulesX = (lot?.rulesJson as any)?.baseMultiplierX;
  if (typeof rulesX === "number" && rulesX > 0) {
    return { valueX: rulesX, source: "loteria.rulesJson.baseMultiplierX" };
  }

  // 4) Fallback global por env
  const def = Number(process.env.MULTIPLIER_BASE_DEFAULT_X ?? 0);
  if (def > 0) {
    return { valueX: def, source: "env.MULTIPLIER_BASE_DEFAULT_X" };
  }

  throw new AppError(
    `Missing baseMultiplierX for bancaId=${bancaId} & loteriaId=${loteriaId}`,
    400
  );
}

// Garantiza que exista un multiplicador "Base" (para linkear en jugadas NUMERO)
async function ensureBaseMultiplierRow(
  tx: Prisma.TransactionClient,
  loteriaId: string
): Promise<string> {
  const existing = await tx.loteriaMultiplier.findFirst({
    where: { loteriaId, isActive: true, name: "Base" },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await tx.loteriaMultiplier.create({
    data: {
      loteriaId,
      name: "Base",
      valueX: 0,
      isActive: true,
      kind: "NUMERO",
    },
    select: { id: true },
  });
  return created.id;
}

// ────────────────────────────────────────────────────────────────────────────────

export const TicketRepository = {
  async create(data: CreateTicketInput, userId: string) {
    const { loteriaId, sorteoId, ventanaId, jugadas, clienteNombre } = data;

    // Toda la operación dentro de una transacción con retry y timeouts explícitos
    // Pre-chequeo seguro: existencia de tabla TicketCounter (fuera de TX para evitar aborts)
    let hasTicketCounter = false;
    try {
      const existsRows = await prisma.$queryRaw<{ present: boolean }[]>(
        Prisma.sql`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = current_schema()
              AND lower(table_name) = 'ticketcounter'
          ) AS present;
        `
      );
      hasTicketCounter = Boolean(existsRows?.[0]?.present);
    } catch (e) {
      // Si falla el chequeo, asumimos que NO existe para no arriesgar abortos dentro de la TX
      hasTicketCounter = false;
    }

    const ticket = await withTransactionRetry(
      async (tx) => {
        // 1) Generación de businessDate CR y folio prefijado por 'TYYMMDD'
        const nowUtc = new Date();
        const cutoffHour = process.env.BUSINESS_CUTOFF_HOUR_CR || '06:00';

        // 2) Validación de FKs + reglas de la lotería + políticas de comisión
        const [loteria, sorteo, ventana, user] = await Promise.all([
          tx.loteria.findUnique({
            where: { id: loteriaId },
            select: { id: true, isActive: true, rulesJson: true },
          }),
          tx.sorteo.findUnique({
            where: { id: sorteoId },
            select: { id: true, status: true, loteriaId: true, scheduledAt: true },
          }),
          tx.ventana.findUnique({
            where: { id: ventanaId },
            select: {
              id: true,
              bancaId: true,
              commissionPolicyJson: true,
              banca: {
                select: {
                  id: true,
                  commissionPolicyJson: true,
                },
              },
            },
          }),
          tx.user.findUnique({
            where: { id: userId },
            select: { id: true, commissionPolicyJson: true },
          }),
        ]);

        if (!user)
          throw new AppError(
            "Seller (vendedor) not found",
            404,
            "FK_VIOLATION"
          );
        if (!loteria || loteria.isActive === false)
          throw new AppError("Lotería not found", 404, "FK_VIOLATION");
        if (!sorteo)
          throw new AppError("Sorteo not found", 404, "FK_VIOLATION");
        if (!ventana)
          throw new AppError("Ventana not found", 404, "FK_VIOLATION");

        // Defensa: el sorteo debe pertenecer a la misma lotería
        if (sorteo.loteriaId !== loteriaId) {
          throw new AppError(
            "El sorteo no pertenece a la lotería indicada",
            400,
            "SORTEO_LOTERIA_MISMATCH"
          );
        }

        // 2) Determinar businessDate CR priorizando sorteo.scheduledAt (fallback por cutoff)
        const bd = getBusinessDateCRInfo({ scheduledAt: sorteo.scheduledAt, nowUtc, cutoffHour });

        // 2.1) Incrementar contador diario por (businessDate, ventanaId) y obtener secuencia
        let nextNumber: string;
        let seqForLog: number | null = null;
        if (hasTicketCounter) {
          const seqRows = await tx.$queryRaw<{ last: number }[]>(
            Prisma.sql`
              INSERT INTO "TicketCounter" ("businessDate", "ventanaId", "last")
              VALUES (${bd.businessDate}::date, ${ventanaId}::uuid, 1)
              ON CONFLICT ("businessDate", "ventanaId")
              DO UPDATE SET "last" = "TicketCounter"."last" + 1
              RETURNING "last";
            `
          );
          const seq = (seqRows?.[0]?.last ?? 1) as number;
          seqForLog = seq;
          const seqPadded = String(seq).padStart(5, '0');
          nextNumber = `T${bd.prefixYYMMDD}-${seqPadded}`;
        } else {
          // Fallback seguro: usar función legacy dentro de TX, sin provocar errores previos
          logger.warn({
            layer: 'repository',
            action: 'TICKET_COUNTER_MISSING_FALLBACK',
            payload: { note: 'Using legacy generate_ticket_number()', businessDateISO: bd.businessDateISO },
          });
          const [seqRow] = await tx.$queryRawUnsafe<{ next_number: string }[]>(
            `SELECT generate_ticket_number() AS next_number`
          );
          if (!seqRow?.next_number) {
            throw new AppError('Failed to generate ticket number (fallback)', 500, 'SEQ_ERROR');
          }
          // Reescribir el prefijo a CR (YYMMDD) preservando el sufijo generado por la función legacy
          // Formato legacy: TYYMMDD-<BASE36(6)>-<CD2>
          const raw = String(seqRow.next_number);
          const firstDash = raw.indexOf('-');
          if (firstDash > 0) {
            const suffix = raw.substring(firstDash + 1); // <BASE36>-<CD2>
            nextNumber = `T${bd.prefixYYMMDD}-${suffix}`;
          } else {
            // Si el formato inesperadamente no contiene '-', usa el valor como viene (último recurso)
            nextNumber = raw;
          }
        }

        // 3) Resolver X efectivo y asegurar fila Base
        const bancaId = ventana.bancaId;

        const { valueX: effectiveBaseX, source } = await resolveBaseMultiplierX(
          tx,
          {
            bancaId,
            loteriaId,
            userId,
            ventanaId,
          }
        );

        const baseMultiplierRowId = await ensureBaseMultiplierRow(
          tx,
          loteriaId
        );

        logger.info({
          layer: "ticket",
          action: "BASE_MULTIPLIER_RESOLVED",
          payload: { bancaId, loteriaId, userId, effectiveBaseX, source },
        });

        // 4) Rules pipeline (User > Ventana > Banca)
        const now = new Date();
        const candidateRules = await tx.restrictionRule.findMany({
          where: {
            isActive: true,
            OR: [{ userId }, { ventanaId }, { bancaId }],
          },
        });

        const applicable = candidateRules
          .filter((r) => {
            if (
              r.appliesToDate &&
              !isSameLocalDay(new Date(r.appliesToDate), now)
            )
              return false;
            if (
              typeof r.appliesToHour === "number" &&
              r.appliesToHour !== now.getHours()
            )
              return false;
            return true;
          })
          .map((r) => {
            let score = 0;
            if (r.bancaId) score += 1;
            if (r.ventanaId) score += 10;
            if (r.userId) score += 100;
            if (r.number) score += 1000;
            return { r, score };
          })
          .sort((a, b) => b.score - a.score)
          .map((x) => x.r);

        // 5) Validaciones con rulesJson de la Lotería
        const RJ = (loteria.rulesJson ?? {}) as any;

        const allowedBetTypes = Array.isArray(RJ.allowedBetTypes)
          ? new Set<string>(RJ.allowedBetTypes)
          : null;
        const reventadoEnabled = !!RJ.reventadoConfig?.enabled;
        const requiresMatchingNumber =
          !!RJ.reventadoConfig?.requiresMatchingNumber;
        const numberRange =
          RJ.numberRange &&
          typeof RJ.numberRange.min === "number" &&
          typeof RJ.numberRange.max === "number"
            ? { min: RJ.numberRange.min, max: RJ.numberRange.max }
            : { min: 0, max: 99 };

        const minBetAmount =
          typeof RJ.minBetAmount === "number" ? RJ.minBetAmount : undefined;
        const maxBetAmount =
          typeof RJ.maxBetAmount === "number" ? RJ.maxBetAmount : undefined;
        const maxNumbersPerTicket =
          typeof RJ.maxNumbersPerTicket === "number"
            ? RJ.maxNumbersPerTicket
            : undefined;

        // a) tipos permitidos
        if (allowedBetTypes) {
          for (const j of jugadas) {
            if (!allowedBetTypes.has(j.type)) {
              throw new AppError(
                `Tipo de jugada no permitido: ${j.type}`,
                400,
                "BETTYPE_NOT_ALLOWED"
              );
            }
          }
        }

        // b) REVENTADO habilitado
        if (!reventadoEnabled) {
          const hasReventado = jugadas.some((j) => j.type === "REVENTADO");
          if (hasReventado) {
            throw new AppError(
              "REVENTADO no está habilitado para esta lotería",
              400,
              "REVENTADO_DISABLED"
            );
          }
        }

        // c) matching de número en REVENTADO (si la regla lo exige)
        if (requiresMatchingNumber) {
          for (const j of jugadas) {
            if (j.type === "REVENTADO") {
              if (!j.reventadoNumber || j.reventadoNumber !== j.number) {
                throw new AppError(
                  "REVENTADO debe coincidir con el mismo número (number === reventadoNumber)",
                  400,
                  "REVENTADO_MATCH_REQUIRED"
                );
              }
            }
          }
        }

        // d) rango de número (respeta numberRange si es más estrecho que 00..99)
        for (const j of jugadas) {
          const num = Number(j.number);
          if (
            Number.isNaN(num) ||
            num < numberRange.min ||
            num > numberRange.max
          ) {
            throw new AppError(
              `Número fuera de rango permitido (${numberRange.min}..${numberRange.max}): ${j.number}`,
              400,
              "NUMBER_OUT_OF_RANGE"
            );
          }
        }

        // e) min/max por jugada
        for (const j of jugadas) {
          if (typeof minBetAmount === "number" && j.amount < minBetAmount) {
            throw new AppError(
              `Monto mínimo por jugada: ${minBetAmount}`,
              400,
              "BET_MIN_VIOLATION"
            );
          }
          if (typeof maxBetAmount === "number" && j.amount > maxBetAmount) {
            throw new AppError(
              `Monto máximo por jugada: ${maxBetAmount}`,
              400,
              "BET_MAX_VIOLATION"
            );
          }
        }

        // f) límite de cantidad de números por ticket (solo NUMERO, únicos)
        if (typeof maxNumbersPerTicket === "number") {
          const uniqueNumeros = new Set(
            jugadas.filter((j) => j.type === "NUMERO").map((j) => j.number)
          );
          if (uniqueNumeros.size > maxNumbersPerTicket) {
            throw new AppError(
              `Máximo de números por ticket: ${maxNumbersPerTicket}`,
              400,
              "MAX_NUMBERS_PER_TICKET"
            );
          }
        }

        // 6) Normalizar jugadas + total
        const preparedJugadas = jugadas.map((j) => {
          if (j.type === "REVENTADO") {
            if (!j.reventadoNumber || j.reventadoNumber !== j.number) {
              throw new AppError(
                "REVENTADO must reference the same number (reventadoNumber === number)",
                400,
                "INVALID_REVENTADO_LINK"
              );
            }
            return {
              type: "REVENTADO" as const,
              number: j.number,
              reventadoNumber: j.reventadoNumber,
              amount: j.amount,
              finalMultiplierX: 0,
              multiplierId: null,
            };
          }
          // NUMERO
          return {
            type: "NUMERO" as const,
            number: j.number,
            reventadoNumber: null,
            amount: j.amount,
            finalMultiplierX: effectiveBaseX, // congelado en venta
            multiplierId: baseMultiplierRowId, // "Base"
          };
        });

        const totalAmountTx = preparedJugadas.reduce(
          (acc, j) => acc + j.amount,
          0
        );

        // 7) Límite diario por vendedor
        const crRange = getCRDayRangeUTC(now);
        const { _sum } = await tx.ticket.aggregate({
          _sum: { totalAmount: true },
          where: {
            vendedorId: userId,
            createdAt: { gte: crRange.fromAt, lt: crRange.toAtExclusive },
          },
        });
        const dailyTotal = _sum.totalAmount ?? 0;
        const MAX_DAILY_TOTAL = Number(process.env.SALES_DAILY_MAX ?? 1000);
        if (dailyTotal + totalAmountTx > MAX_DAILY_TOTAL) {
          throw new AppError(
            "Daily sales limit exceeded",
            400,
            "LIMIT_VIOLATION"
          );
        }

        // 8) Aplicar primera regla aplicable (si hay)
        if (applicable.length > 0) {
          const rule = applicable[0];
          if (rule.number) {
            const sumForNumber = preparedJugadas
              .filter((j) => j.number === rule.number)
              .reduce((acc, j) => acc + j.amount, 0);

            if (rule.maxAmount && sumForNumber > rule.maxAmount)
              throw new AppError(
                `Number ${rule.number} exceeded maxAmount (${rule.maxAmount})`,
                400
              );

            if (rule.maxTotal && totalAmountTx > rule.maxTotal)
              throw new AppError(
                `Ticket total exceeded maxTotal (${rule.maxTotal})`,
                400
              );
          } else {
            if (rule.maxAmount) {
              const maxBet = Math.max(...preparedJugadas.map((j) => j.amount));
              if (maxBet > rule.maxAmount)
                throw new AppError(
                  `Bet amount exceeded maxAmount (${rule.maxAmount})`,
                  400
                );
            }
            if (rule.maxTotal && totalAmountTx > rule.maxTotal)
              throw new AppError(
                `Ticket total exceeded maxTotal (${rule.maxTotal})`,
                400
              );
          }
        }

        // 9) Crear ticket y jugadas con comisiones
        // Acumular datos para ActivityLog
        const commissionsDetails: any[] = [];

        // Normalizar clienteNombre: trim y default "CLIENTE CONTADO"
        const normalizedClienteNombre = (clienteNombre?.trim() || "CLIENTE CONTADO");

        // Precalcular snapshot de comisión por jugada con policy del usuario (solo USER)
        const userPolicy = (user?.commissionPolicyJson ?? null) as any;
        const createdTicket = await tx.ticket.create({
          data: {
            ticketNumber: nextNumber,
            loteriaId,
            sorteoId,
            ventanaId,
            vendedorId: userId,
            totalAmount: totalAmountTx,
            status: TicketStatus.ACTIVE,
            isActive: true,
            clienteNombre: normalizedClienteNombre,
            jugadas: {
              create: preparedJugadas.map((j) => {
                // Resolver comisión únicamente desde policy del USER
                const res = resolveCommissionFromPolicy(userPolicy, {
                  userId,
                  loteriaId,
                  betType: j.type,
                  finalMultiplierX: j.finalMultiplierX,
                });

                const commissionPercent = Math.round(res.percent); // normalizar entero
                const commissionAmount = Math.round((j.amount * commissionPercent) / 100);

                // Guardar para ActivityLog
                commissionsDetails.push({
                  origin: res.origin,
                  ruleId: res.ruleId ?? null,
                  percent: commissionPercent,
                  amount: commissionAmount,
                  loteriaId,
                  betType: j.type,
                  multiplierX: j.finalMultiplierX,
                  jugadaAmount: j.amount,
                });

                return {
                  type: j.type,
                  number: j.number,
                  reventadoNumber: j.reventadoNumber ?? null,
                  amount: j.amount,
                  finalMultiplierX: j.finalMultiplierX,
                  commissionPercent,
                  commissionAmount,
                  commissionOrigin: 'USER',
                  commissionRuleId: res.ruleId ?? null,
                  ...(j.multiplierId
                    ? { multiplier: { connect: { id: j.multiplierId } } }
                    : {}),
                };
              }),
            },
          },
          include: { jugadas: true },
        });

        // Adjuntar businessDate info para persistirla fuera de la TX (evita abortos si falta la columna)
        (createdTicket as any).__businessDateInfo = bd;

        // Diagnóstico de folio
        logger.info({
          layer: 'repository',
          action: 'TICKET_FOLIO_DIAG',
          payload: {
            createdAtUTC: new Date().toISOString(),
            scheduledAt: sorteo.scheduledAt?.toISOString() ?? null,
            businessDateISO: bd.businessDateISO,
            prefixYYMMDD: bd.prefixYYMMDD,
            counter: seqForLog,
            ticketNumber: nextNumber,
          },
        });

        // Almacenar commissionsDetails en el ticket para usarlo fuera de TX
        (createdTicket as any).__commissionsDetails = commissionsDetails;

        return createdTicket;
      },
      {
        // ✔️ opciones explícitas para robustez bajo carga
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxRetries: 3,
        backoffMinMs: 150,
        backoffMaxMs: 2_000,
        maxWaitMs: 10_000,
        timeoutMs: 20_000,
      }
    );

    // 9.1) Persistir businessDate fuera de la transacción
    const bdInfo = (ticket as any).__businessDateInfo as ReturnType<typeof getBusinessDateCRInfo> | undefined;
    if (bdInfo) {
      try {
        await prisma.$executeRaw(
          Prisma.sql`UPDATE "Ticket" SET "businessDate" = ${bdInfo.businessDate}::date WHERE id = ${ticket.id}::uuid`
        );
      } catch (e) {
        logger.warn({
          layer: 'repository',
          action: 'BUSINESS_DATE_NOT_PERSISTED',
          payload: { ticketId: ticket.id, reason: (e as Error).message, businessDateISO: bdInfo.businessDateISO },
        });
      }
    }

    // ActivityLog fuera de la TX (no bloqueante)
    const commissionsDetailsForLog = (ticket as any).__commissionsDetails || [];
    prisma.activityLog
      .create({
        data: {
          userId,
          action: "TICKET_CREATE",
          targetType: "TICKET",
          targetId: ticket.id,
          details: {
            ticketNumber: ticket.ticketNumber,
            totalAmount: ticket.totalAmount,
            jugadas: ticket.jugadas.length,
            commissions: commissionsDetailsForLog,
          },
        },
      })
      .catch((err) =>
        logger.warn({
          layer: "activityLog",
          action: "ASYNC_FAIL",
          payload: { message: err.message },
        })
      );

    // Logging
    logger.info({
      layer: "repository",
      action: "TICKET_CREATE_TX",
      payload: {
        ticketId: ticket.id,
        ticketNumber: ticket.ticketNumber,
        totalAmount: ticket.totalAmount,
        jugadas: ticket.jugadas.length,
      },
    });

    logger.debug({
      layer: "repository",
      action: "TICKET_DEBUG",
      payload: {
        loteriaId,
        sorteoId,
        ventanaId,
        vendedorId: userId,
        jugadas,
      },
    });

    return ticket;
  },

  async getById(id: string) {
    return prisma.ticket.findUnique({
      where: { id },
      include: {
        jugadas: true,
        loteria: true,
        sorteo: true,
        ventana: true,
        vendedor: true,
      },
    });
  },

  async list(
    page = 1,
    pageSize = 10,
    filters: {
      status?: TicketStatus;
      isActive?: boolean;
      sorteoId?: string;
      ventanaId?: string;
      search?: string;
      userId?: string;
      dateFrom?: Date;
      dateTo?: Date;
    } = {}
  ) {
    const skip = (page - 1) * pageSize;

    const where: Prisma.TicketWhereInput = {
      ...(filters.status ? { status: filters.status } : {}),
      ...(typeof filters.isActive === "boolean"
        ? { isActive: filters.isActive }
        : { isActive: filters.isActive }),
      ...(filters.sorteoId ? { sorteoId: filters.sorteoId } : {}),
      ...(filters.userId ? { vendedorId: filters.userId } : {}),
      ...(filters.ventanaId ? { ventanaId: filters.ventanaId } : {}), // ✅ ahora sí aplica
      ...(filters.dateFrom || filters.dateTo
        ? {
            createdAt: {
              ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
              ...(filters.dateTo ? { lt: filters.dateTo } : {}), // ✅ medio-abierto
            },
          }
        : {}),
    };

    // búsqueda unificada
    const s = typeof filters.search === "string" ? filters.search.trim() : "";
    if (s.length > 0) {
      const isDigits = /^\d+$/.test(s);
      const n = isDigits ? Number(s) : null;

      const existingAnd = where.AND
        ? Array.isArray(where.AND)
          ? where.AND
          : [where.AND]
        : [];

      where.AND = [
        ...existingAnd,
        {
          OR: [
            ...(n !== null
              ? [{ ticketNumber: n } as Prisma.TicketWhereInput]
              : []),
            { vendedor: { name: { contains: s, mode: "insensitive" } } },
            { ventana: { name: { contains: s, mode: "insensitive" } } },
            { loteria: { name: { contains: s, mode: "insensitive" } } },
            { sorteo: { name: { contains: s, mode: "insensitive" } } },
          ],
        },
      ];
    }

    const [data, total] = await prisma.$transaction([
      prisma.ticket.findMany({
        where,
        skip,
        take: pageSize,
        include: {
          loteria: { select: { id: true, name: true } },
          sorteo: {
            select: { id: true, name: true, status: true, scheduledAt: true },
          },
          ventana: { select: { id: true, name: true } },
          vendedor: { select: { id: true, name: true, role: true } },
          jugadas: true,
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.ticket.count({ where }),
    ]);

    const totalPages = Math.ceil(total / pageSize);
    const meta = {
      total,
      page,
      pageSize,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    logger.info({
      layer: "repository",
      action: "TICKET_LIST",
      payload: {
        filters: { ...filters, search: s || undefined },
        page,
        pageSize,
        total,
      },
    });

    return { data, meta };
  },

  async cancel(id: string, userId: string) {
    // Cancelación bajo retry + timeouts (misma estrategia que create)
    const ticket = await withTransactionRetry(
      async (tx) => {
        // 1) Verificar existencia y estado
        const existing = await tx.ticket.findUnique({
          where: { id },
          include: { sorteo: true },
        });

        if (!existing) {
          throw new AppError("Ticket not found", 404, "NOT_FOUND");
        }

        if (existing.status === TicketStatus.EVALUATED) {
          throw new AppError(
            "Cannot cancel an evaluated ticket",
            400,
            "INVALID_STATE"
          );
        }

        // 2) Validar sorteo (no permitir cancelar si el sorteo ya está cerrado o evaluado)
        if (
          existing.sorteo.status === "CLOSED" ||
          existing.sorteo.status === "EVALUATED"
        ) {
          throw new AppError(
            "Cannot cancel ticket from closed or evaluated sorteo",
            400,
            "SORTEO_LOCKED"
          );
        }

        // 3) Actualizar ticket (soft delete + inactivar)
        const cancelled = await tx.ticket.update({
          where: { id },
          data: {
            isActive: false,

            status: TicketStatus.CANCELLED,
            updatedAt: new Date(),
          },
          include: { jugadas: true },
        });

        return cancelled;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxRetries: 3,
        backoffMinMs: 150,
        backoffMaxMs: 2_000,
        maxWaitMs: 10_000,
        timeoutMs: 20_000,
      }
    );

    // ActivityLog fuera de la TX (no bloqueante)
    prisma.activityLog
      .create({
        data: {
          userId,
          action: "TICKET_CANCEL",
          targetType: "TICKET",
          targetId: ticket.id,
          details: {
            ticketNumber: ticket.ticketNumber,
            totalAmount: ticket.totalAmount,
            cancelledAt: ticket.updatedAt,
          },
        },
      })
      .catch((err) =>
        logger.warn({
          layer: "activityLog",
          action: "ASYNC_FAIL",
          payload: { message: err.message },
        })
      );

    // Logging global
    logger.warn({
      layer: "repository",
      action: "TICKET_CANCEL_DB",
      payload: {
        ticketId: id,
        userId,
        sorteoId: (ticket as any).sorteoId,
        totalAmount: ticket.totalAmount,
      },
    });

    return ticket;
  },
};

export default TicketRepository;
