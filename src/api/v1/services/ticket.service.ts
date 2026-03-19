import { ActivityType, Prisma, Role, TicketStatus } from "@prisma/client";
import { withConnectionRetry } from "../../../core/withConnectionRetry";
import TicketRepository from "../../../repositories/ticket.repository";
import ActivityService from "../../../core/activity.service";
import logger from "../../../core/logger";
import { AppError } from "../../../core/errors";
import prisma from "../../../core/prismaClient";
import { RestrictionRuleRepository } from "../../../repositories/restrictionRule.repository";
import { isWithinSalesHours, validateTicketAgainstRules } from "../../../utils/loteriaRules";
import { commissionService } from "../../../services/commission/CommissionService";
import { CommissionContext } from "../../../services/commission/types/CommissionContext";
import { getExclusionWhereCondition } from "./sorteo-listas.helpers";
import { resolveDateRange, DateRangeResolution } from "../../../utils/dateRange";
import { UserService } from "./user.service";
import { nowCR, validateDate, formatDateCRWithTZ } from "../../../utils/datetime";
import { getCRLocalComponents } from "../../../utils/businessDate";
import { PDFDocument } from "pdf-lib";
import { ConcurrencyManager } from "../../../utils/concurrency";
import { CacheService } from "../../../core/cache.service";
import crypto from 'crypto';

const CUTOFF_GRACE_MS = 1000;
// Updated: Added clienteNombre field support

// In-flight deduplication para getNumbersSummaryFilterOptions
// Evita que N requests concurrentes con los mismos parámetros lancen N rondas de queries
const _filterOptionsInFlight = new Map<string, Promise<any>>();

/**
 * Extrae la configuración de impresión de un usuario/ventana
 * Retorna un objeto con printName, printPhone, printWidth, printFooter, printBarcode, printBluetoothMacAddress
 */
function extractPrintConfig(settings: any, defaultName: string | null, defaultPhone: string | null) {
  const printSettings = (settings as any)?.print ?? {};
  return {
    printName: printSettings.name ?? defaultName,
    printPhone: printSettings.phone ?? defaultPhone,
    printWidth: printSettings.width ?? null,
    printFooter: printSettings.footer ?? null,
    printBarcode: printSettings.barcode ?? true,
    printBluetoothMacAddress: printSettings.bluetoothMacAddress ?? null,
  };
}

/**
 * Formatea la hora de un Date a formato "h:mm a" (ej: "7:00 PM", "12:00 PM")
 * Usa hora local de Costa Rica
 */
function formatTime12h(date: Date): string {
  const { hour, minute } = getCRLocalComponents(date);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  let hours12 = hour % 12;
  hours12 = hours12 || 12; // 0 debe ser 12
  const minutesStr = String(minute).padStart(2, '0');
  return `${hours12}:${minutesStr} ${ampm}`;
}

/**
 * Formatea el nombre del sorteo concatenando la hora al nombre existente
 * Ejemplo: "TICA" + "7:00 PM" = "TICA 7:00 PM"
 */
function formatSorteoNameWithTime(sorteoName: string, scheduledAt: Date): string {
  const timeFormatted = formatTime12h(scheduledAt);
  return `${sorteoName} ${timeFormatted}`;
}

// Interfaces para pagos
interface RegisterPaymentInput {
  amountPaid: number;
  method?: string;
  notes?: string;
  isFinal?: boolean;
  idempotencyKey?: string;
}

interface PaymentHistoryEntry {
  id: string;
  amountPaid: number;
  paidAt: string;
  paidById: string;
  paidByName: string;
  method: string;
  notes?: string;
  isFinal: boolean;
  isReversed: boolean;
  reversedAt?: string;
  reversedBy?: string;
}

export const TicketService = {
  async create(
    data: any,
    userId: string,
    requestId?: string,
    actorRole: Role = Role.VENDEDOR
  ) {
    try {
      const { loteriaId, sorteoId } = data;
      if (!loteriaId || !sorteoId) throw new AppError("Missing loteriaId/sorteoId", 400);

      // Actor autenticado
      const actor = await withConnectionRetry(
        () => prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, role: true, ventanaId: true, isActive: true },
        }),
        { context: 'TicketService.create.actor' }
      );
      if (!actor) throw new AppError("Authenticated user not found", 401);

      // Resolver vendedor efectivo (impersonación opcional para ADMIN/VENTANA)
      const requestedVendedorId: string | undefined = data?.vendedorId;
      let effectiveVendedorId: string;
      let ventanaId: string;

      if (requestedVendedorId) {
        // Permitir que el VENDEDOR mande su propio ID (algunos FE lo hacen para evitar errores de validación)
        if (actor.role === Role.VENDEDOR && requestedVendedorId !== actor.id) {
          throw new AppError("No tienes permiso para vender a nombre de otro usuario", 403);
        }

        // Si no es VENDEDOR, validar permisos de impersonación usuales para ADMIN/VENTANA
        if (actor.role !== Role.VENDEDOR && actor.role !== Role.ADMIN && actor.role !== Role.VENTANA) {
          throw new AppError("No tienes permisos para realizar esta acción", 403);
        }

        const target = await withConnectionRetry(
          () => prisma.user.findUnique({
            where: { id: requestedVendedorId },
            select: { id: true, role: true, ventanaId: true, isActive: true },
          }),
          { context: 'TicketService.create.targetVendedor' }
        );
        if (!target || !target.isActive) throw new AppError("Vendedor no encontrado o inactivo", 404);
        if (target.role !== Role.VENDEDOR) throw new AppError("vendedorId debe pertenecer a un usuario con rol VENDEDOR", 400);
        if (!target.ventanaId) throw new AppError("El vendedor seleccionado no tiene Ventana asignada", 400);
        if (actor.role === Role.VENTANA) {
          if (!actor.ventanaId || actor.ventanaId !== target.ventanaId) {
            throw new AppError("vendedorId no pertenece a tu Ventana", 403);
          }
        }
        effectiveVendedorId = target.id;
        ventanaId = target.ventanaId;
      } else {
        if (actor.role === Role.VENDEDOR) {
          if (!actor.ventanaId) throw new AppError("El vendedor no tiene una Ventana asignada", 400);
          effectiveVendedorId = actor.id;
          ventanaId = actor.ventanaId;
        } else {
          throw new AppError("vendedorId es requerido para este rol", 400);
        }
      }

      // Ventana válida
      const ventana = await withConnectionRetry(
        () => prisma.ventana.findUnique({
          where: { id: ventanaId },
          select: { id: true, bancaId: true, isActive: true },
        }),
        { context: 'TicketService.create.ventana' }
      );
      if (!ventana || !ventana.isActive) throw new AppError("La Ventana no existe o está inactiva", 404);

      // Sorteo válido + obtener lotería desde sorteo
      const sorteo = await withConnectionRetry(
        () => prisma.sorteo.findUnique({
          where: { id: sorteoId },
          select: {
            id: true,
            name: true, //  Incluir name para formatear con hora
            scheduledAt: true,
            status: true,
            loteriaId: true,
            loteria: { select: { id: true, name: true, rulesJson: true } },
          },
        }),
        { context: 'TicketService.create.sorteo' }
      );
      if (!sorteo) throw new AppError("Sorteo no encontrado", 404);

      //  NUEVA VALIDACIÓN: Verificar que el sorteo no esté cerrado
      if (sorteo.status === "CLOSED") {
        throw new AppError(
          "No se pueden crear tickets en un sorteo cerrado",
          409
        );
      }

      // Validar que loteriaId del request coincida con loteriaId del sorteo
      if (loteriaId !== sorteo.loteriaId) {
        throw new AppError(
          `loteriaId mismatch: request=${loteriaId}, sorteo=${sorteo.loteriaId}`,
          400
        );
      }

      //  VALIDACIÓN DEFENSIVA: Verificar que scheduledAt sea válido ANTES de calcular fechas
      try {
        validateDate(sorteo.scheduledAt, 'sorteo.scheduledAt');
      } catch (err: any) {
        logger.error({
          layer: "service",
          action: "INVALID_SORTEO_SCHEDULED_AT",
          userId,
          requestId,
          payload: {
            sorteoId,
            scheduledAt: sorteo.scheduledAt,
            error: err.message,
          },
        });
        throw new AppError(
          `El sorteo ${sorteoId} tiene una fecha programada inválida. Por favor contacta al administrador.`,
          400,
          "INVALID_SORTEO_SCHEDULED_AT"
        );
      }

      //  cutoff efectivo (rules → RestrictionRuleRepository)
      const cutoff = await RestrictionRuleRepository.resolveSalesCutoff({
        bancaId: ventana.bancaId,
        ventanaId,
        userId: effectiveVendedorId, //  CORRECCIÓN: Usar el vendedor efectivo para respetar sus reglas
        defaultCutoff: 1,
      });

      const now = nowCR(); //  Usar nowCR() en lugar de new Date()

      //  VALIDACIÓN DEFENSIVA: Asegurar que minutes sea un número válido
      const safeMinutes = (typeof cutoff.minutes === 'number' && !isNaN(cutoff.minutes))
        ? cutoff.minutes
        : 1; // Fallback seguro a 1 min si viene corrupto

      const cutoffMs = safeMinutes * 60_000;
      const limitTime = new Date(sorteo.scheduledAt.getTime() - cutoffMs);
      const effectiveLimitTime = new Date(limitTime.getTime() + CUTOFF_GRACE_MS);

      logger.info({
        layer: "service",
        action: "TICKET_CUTOFF_DIAG",
        userId,
        requestId,
        payload: {
          cutOff: { minutes: safeMinutes, source: cutoff.source },
          bancaId: ventana.bancaId,
          ventanaId,
          effectiveVendedorId,
          nowISO: now.toISOString(),
          scheduledAtISO: formatDateCRWithTZ(sorteo.scheduledAt),
          limitTimeISO: limitTime.toISOString(),
          effectiveLimitTimeISO: effectiveLimitTime.toISOString(),
          sorteoStatus: sorteo.status,
          timeUntilSorteoMinutes: Math.ceil((sorteo.scheduledAt.getTime() - now.getTime()) / 60_000),
        },
      });

      // ️ ALERTA: Si se usa DEFAULT fallback, loggear warning
      if (cutoff.source === "DEFAULT") {
        logger.warn({
          layer: "service",
          action: "TICKET_CUTOFF_USING_DEFAULT",
          userId,
          requestId,
          payload: {
            bancaId: ventana.bancaId,
            ventanaId,
            effectiveVendedorId,
            defaultCutoffUsed: safeMinutes,
            message: "Cutoff is using DEFAULT fallback - no RestrictionRule or Banca.salesCutoffMinutes found",
          },
        });
      }

      if (now >= effectiveLimitTime) {
        const minsLeft = Math.max(0, Math.ceil((sorteo.scheduledAt.getTime() - now.getTime()) / 60_000));
        throw new AppError(
          `Venta bloqueada: faltan ${minsLeft} min para el sorteo (cutoff=${safeMinutes} min, source=${cutoff.source})`,
          409
        );
      }

      //  Jugadas (el validador ya corrió)
      const jugadasIn: Array<{
        type?: "NUMERO" | "REVENTADO";
        number?: string;
        reventadoNumber?: string | null;
        amount: number;
      }> = Array.isArray(data.jugadas) ? data.jugadas : [];
      if (jugadasIn.length === 0) throw new AppError("At least one jugada is required", 400);

      // Seguridad extra: reventado apunta a un NUMERO del mismo ticket
      const numeros = new Set(
        jugadasIn
          .filter((j) => (j.type ?? "NUMERO") === "NUMERO")
          .map((j) => {
            if (!j.number) throw new AppError("NUMERO jugada requires 'number'", 400);
            return j.number;
          })
      );
      for (const j of jugadasIn) {
        const type = j.type ?? "NUMERO";
        if (type === "REVENTADO") {
          const target = j.reventadoNumber ?? j.number;
          if (!target) throw new AppError("REVENTADO requires 'reventadoNumber'", 400);
          if (!numeros.has(target)) {
            throw new AppError(`Debe existir una jugada NUMERO para ${target} en el mismo ticket`, 400);
          }
        }
      }

      //  Validaciones por rulesJson de la Lotería (horarios + reglas de jugadas)
      // Nota: loteria ya fue obtenida del sorteo arriba
      const rules = (sorteo.loteria?.rulesJson ?? {}) as any;

      // 1) horario
      if (!isWithinSalesHours(now, rules)) {
        throw new AppError("Fuera del horario de ventas para hoy", 409);
      }

      // 2) reglas del ticket
      const rulesCheck = validateTicketAgainstRules({
        loteriaRules: rules,
        jugadas: jugadasIn.map((j) => ({
          type: (j.type ?? "NUMERO") as "NUMERO" | "REVENTADO",
          number: j.number ?? j.reventadoNumber ?? "",
          amount: j.amount,
          reventadoNumber: j.reventadoNumber ?? undefined,
        })),
      });
      if (!rulesCheck.ok) {
        throw new AppError(rulesCheck.reason, 400);
      }

      //  OPTIMIZACIÓN: Pre-calcular comisiones fuera de la transacción
      // Obtener políticas de comisión (una sola vez)
      const [user, ventanaWithBanca, listeroUser] = await withConnectionRetry(
        () => Promise.all([
          prisma.user.findUnique({
            where: { id: effectiveVendedorId },
            select: { commissionPolicyJson: true },
          }),
          prisma.ventana.findUnique({
            where: { id: ventanaId },
            select: {
              commissionPolicyJson: true,
              banca: {
                select: {
                  commissionPolicyJson: true,
                },
              },
            },
          }),
          //  Fetch listero user (Role.VENTANA) for this ventana
          prisma.user.findFirst({
            where: {
              role: Role.VENTANA,
              ventanaId: ventanaId,
              isActive: true,
              deletedAt: null,
            },
            select: { commissionPolicyJson: true, id: true },
            orderBy: { updatedAt: "desc" },
          }),
        ]),
        { context: 'TicketService.create.policies' }
      );

      // Preparar contexto de comisiones (parsear y cachear políticas)
      const commissionContext = await commissionService.prepareContext(
        effectiveVendedorId,
        ventanaId,
        ventana.bancaId,
        user?.commissionPolicyJson ?? null,
        ventanaWithBanca?.commissionPolicyJson ?? null,
        ventanaWithBanca?.banca?.commissionPolicyJson ?? null,
        listeroUser?.commissionPolicyJson ?? null //  Pass listero policy
      );

      //  Normalizar jugadas para repo (sin comisiones aún)
      const normalizedJugadas = jugadasIn.map((j) => {
        const type = (j.type ?? "NUMERO") as "NUMERO" | "REVENTADO";
        const isNumero = type === "NUMERO";
        const number = isNumero ? j.number! : (j.reventadoNumber ?? j.number)!;
        return {
          type,
          number,
          reventadoNumber: isNumero ? null : number,
          amount: j.amount,
          multiplierId: isNumero ? ((j as any).multiplierId ?? null) : null,
          finalMultiplierX: 0, // Se calculará en el repo
        };
      });

      //  Determinar campos de auditoría (createdBy y createdByRole)
      // Si el vendedor efectivo es diferente al actor autenticado, fue creado por otro
      let createdBy: string | undefined;
      let createdByRole: Role | undefined;

      if (effectiveVendedorId === actor.id) {
        // Ticket creado por el propio vendedor
        createdBy = actor.id;
        createdByRole = Role.VENDEDOR;
      } else {
        // Ticket creado por admin/ventana para otro vendedor
        createdBy = actor.id;
        createdByRole = actor.role;
      }

      //  Idempotencia a nivel DB: verificar si ya existe un ticket con esta key
      const clientIdempotencyKey: string | undefined = data.idempotencyKey ?? data.requestId;
      if (clientIdempotencyKey) {
        const existing = await withConnectionRetry(
          () => prisma.$queryRaw<{ id: string }[]>`
            SELECT id FROM "Ticket"
            WHERE "idempotencyKey" = ${clientIdempotencyKey}
              AND "deletedAt" IS NULL
            LIMIT 1
          `,
          { context: 'TicketService.create.idempotencyCheck' }
        );
        if (existing.length > 0) {
          logger.info({
            layer: 'service',
            action: 'TICKET_CREATE_DB_IDEMPOTENCY_HIT',
            userId,
            requestId,
            payload: { idempotencyKey: clientIdempotencyKey, existingId: existing[0].id },
          });
          return TicketRepository.getById(existing[0].id);
        }
      }

      //  Crear ticket con método optimizado
      let ticket: any;
      let warnings: any[];
      try {
        ({ ticket, warnings } = await TicketRepository.createOptimized(
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
            commissionContext, // Pasar contexto para cálculo rápido
            createdBy,
            createdByRole,
            scheduledAt: sorteo.scheduledAt,
            idempotencyKey: clientIdempotencyKey,
          }
        ));
      } catch (err: any) {
        // P2002 en idempotencyKey = carrera entre procesos con el mismo key
        if (
          err?.code === 'P2002' &&
          (err?.meta?.target as string[] | undefined)?.includes('idempotencyKey')
        ) {
          const row = await withConnectionRetry(
            () => prisma.$queryRaw<{ id: string }[]>`
              SELECT id FROM "Ticket"
              WHERE "idempotencyKey" = ${clientIdempotencyKey}
                AND "deletedAt" IS NULL
              LIMIT 1
            `,
            { context: 'TicketService.create.idempotencyRaceRecover' }
          );
          if (row.length > 0) {
            logger.info({
              layer: 'service',
              action: 'TICKET_CREATE_DB_IDEMPOTENCY_RACE_HIT',
              userId,
              requestId,
              payload: { idempotencyKey: clientIdempotencyKey },
            });
            return TicketRepository.getById(row[0].id);
          }
        }
        throw err;
      }

      //  FASE BE-2: Invalidar caché del vendedor (summary)
      // Usamos fire-and-forget para no bloquear el flujo de venta
      CacheService.invalidateTag(`vendedor:${effectiveVendedorId}`).catch(err => {
        logger.warn({ layer: 'cache', action: 'INVALIDATE_ERROR_ON_CREATE', payload: { vendedorId: effectiveVendedorId, error: err.message } });
      });

      // ️ Obtener configuraciones de impresión del vendedor y ventana
      const [vendedor, ventanaData] = await withConnectionRetry(
        () => Promise.all([
          prisma.user.findUnique({
            where: { id: effectiveVendedorId },
            select: { name: true, phone: true, settings: true },
          }),
          prisma.ventana.findUnique({
            where: { id: ventanaId },
            select: { name: true, phone: true, settings: true },
          }),
        ]),
        { context: 'TicketService.create.printConfigs' }
      );

      //  Formatear sorteo.name concatenando la hora (requerido por frontend)
      // El ticket de createOptimized no incluye sorteo, así que lo obtenemos por separado
      const sorteoWithFormattedName = {
        ...sorteo,
        name: formatSorteoNameWithTime(sorteo.name, sorteo.scheduledAt),
      };

      // Enriquecer respuesta con configuraciones de impresión
      const response = {
        ...ticket,
        sorteo: sorteoWithFormattedName,
        vendedor: {
          id: effectiveVendedorId,
          ...extractPrintConfig(vendedor?.settings, vendedor?.name || null, vendedor?.phone || null),
        },
        ventana: {
          id: ventanaId,
          ...extractPrintConfig(ventanaData?.settings, ventanaData?.name || null, ventanaData?.phone || null),
        },
      };

      // Obtener número de jugadas (el ticket incluye jugadas pero TypeScript no lo infiere)
      const jugadasList = (ticket as any).jugadas || [];
      const jugadasCount = jugadasList.length ?? jugadasIn.length;

      // Detallar jugadas en la descripción
      const jugadasSummary = jugadasList
        .map((j: any) => `${j.type === 'REVENTADO' ? 'R:' : '#'}${j.number}: ₡${j.amount.toLocaleString()}`)
        .join(", ");

      await ActivityService.log({
        userId,
        action: ActivityType.TICKET_CREATE,
        targetType: "TICKET",
        targetId: ticket.id,
        details: {
          ticketNumber: ticket.ticketNumber,
          totalAmount: ticket.totalAmount,
          jugadas: jugadasCount,
          description: `Ticket #${ticket.ticketNumber} creado por [${effectiveVendedorId}] - ${vendedor?.name || 'N/A'} para ${sorteo.loteria.name} - ${sorteoWithFormattedName.name} por un monto de ₡${ticket.totalAmount.toLocaleString()}. Jugadas: [${jugadasSummary}]`,
        },
        requestId,
        layer: "service",
      });

      logger.info({
        layer: "service",
        action: "TICKET_CREATE",
        userId,
        requestId,
        payload: { ticketId: ticket.id, totalAmount: ticket.totalAmount, jugadas: jugadasCount },
      });

      if (warnings && warnings.length > 0) {
        logger.warn({
          layer: "service",
          action: "TICKET_CREATE_WARNINGS",
          userId,
          requestId,
          payload: { warnings },
        });
      }

      if (warnings && warnings.length > 0) {
        (response as any).warnings = warnings;
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
  },

  async getById(id: string) {
    const ticket = await TicketRepository.getById(id);

    if (!ticket) {
      throw new AppError("Ticket no encontrado", 404);
    }

    //  Validar que sorteo existe y tiene name (requerido por frontend)
    if (!ticket.sorteo) {
      logger.error({
        layer: "service",
        action: "TICKET_GET_BY_ID_SORTEO_MISSING",
        payload: {
          ticketId: id,
          sorteoId: ticket.sorteoId,
          message: "El ticket no tiene un sorteo asociado válido",
        },
      });
      throw new AppError("El ticket no tiene un sorteo asociado válido", 500);
    }

    if (!ticket.sorteo.name || ticket.sorteo.name.trim() === "") {
      logger.warn({
        layer: "service",
        action: "TICKET_GET_BY_ID_SORTEO_NAME_MISSING",
        payload: {
          ticketId: id,
          sorteoId: ticket.sorteoId,
          sorteo: {
            id: ticket.sorteo.id,
            name: ticket.sorteo.name,
            scheduledAt: ticket.sorteo.scheduledAt,
            status: ticket.sorteo.status,
          },
          message: "El sorteo asociado no tiene nombre o está vacío",
        },
      });
      throw new AppError("El sorteo asociado no tiene nombre válido", 500);
    }

    // ️ Obtener configuraciones de impresión del vendedor y ventana
    const [vendedor, ventanaData] = await withConnectionRetry(
      () => Promise.all([
        prisma.user.findUnique({
          where: { id: ticket.vendedorId },
          select: { name: true, phone: true, settings: true },
        }),
        prisma.ventana.findUnique({
          where: { id: ticket.ventanaId },
          select: { name: true, phone: true, settings: true },
        }),
      ]),
      { context: 'TicketService.reprint.printConfigs' }
    );

    //  Formatear sorteo.name concatenando la hora (requerido por frontend)
    const sorteoWithFormattedName = {
      ...ticket.sorteo,
      name: formatSorteoNameWithTime(ticket.sorteo.name, ticket.sorteo.scheduledAt),
    };

    // Enriquecer respuesta con configuraciones de impresión
    const enriched = {
      ...ticket,
      sorteo: sorteoWithFormattedName,
      vendedor: ticket.vendedor ? {
        ...ticket.vendedor,
        ...extractPrintConfig(vendedor?.settings, vendedor?.name || null, vendedor?.phone || null),
      } : undefined,
      ventana: ticket.ventana ? {
        ...ticket.ventana,
        ...extractPrintConfig(ventanaData?.settings, ventanaData?.name || null, ventanaData?.phone || null),
      } : undefined,
    };
    return enriched;
  },

  async list(page = 1, pageSize = 10, filters: any = {}): Promise<ReturnType<typeof TicketRepository.list>> {
    return TicketRepository.list(page, pageSize, filters);
  },

  async cancel(id: string, userId: string, requestId?: string) {
    // 1) Obtener ticket completo para validación de cutoff
    const existing = await TicketRepository.getById(id);
    if (!existing) {
      throw new AppError("Ticket no encontrado", 404, "NOT_FOUND");
    }

    // 2) Validar cutoff (igual que en la creación)
    // Se utiliza el bancaId, ventanaId y vendedorId del ticket original
    const cutoff = await RestrictionRuleRepository.resolveSalesCutoff({
      bancaId: existing.ventana.bancaId,
      ventanaId: existing.ventanaId,
      userId: existing.vendedorId,
      defaultCutoff: 1,
    });

    const now = nowCR();
    const safeMinutes = (typeof cutoff.minutes === 'number' && !isNaN(cutoff.minutes))
      ? cutoff.minutes
      : 1;

    const cutoffMs = safeMinutes * 60_000;
    const limitTime = new Date(existing.sorteo.scheduledAt.getTime() - cutoffMs);
    const effectiveLimitTime = new Date(limitTime.getTime() + CUTOFF_GRACE_MS);

    if (now >= effectiveLimitTime) {
      const minsLeft = Math.max(0, Math.ceil((existing.sorteo.scheduledAt.getTime() - now.getTime()) / 60_000));
      throw new AppError(
        `Anulación bloqueada: faltan ${minsLeft} min para el sorteo (cutoff=${safeMinutes} min, fuente=${cutoff.source})`,
        409,
        "SALES_CUTOFF_REACHED"
      );
    }

    const ticket = await TicketRepository.cancel(id, userId);

    //  FASE BE-2: Invalidar caché del vendedor
    if (ticket.vendedorId) {
      CacheService.invalidateTag(`vendedor:${ticket.vendedorId}`).catch(err => {
        logger.warn({ layer: 'cache', action: 'INVALIDATE_ERROR_ON_CANCEL', payload: { vendedorId: ticket.vendedorId, error: err.message } });
      });
    }

    await ActivityService.log({
      userId,
      action: ActivityType.TICKET_CANCEL,
      targetType: "TICKET",
      targetId: id,
      details: {
        ticketNumber: ticket.ticketNumber,
        totalAmount: ticket.totalAmount,
        reason: "Cancelled by user",
        description: `Ticket #${ticket.ticketNumber} cancelado (Monto: ₡${ticket.totalAmount.toLocaleString()})`
      },
      requestId,
      layer: "service",
    });

    logger.warn({
      layer: "service",
      action: "TICKET_CANCEL",
      userId,
      requestId,
      payload: { ticketId: id },
    });

    return ticket;
  },

  async restore(id: string, userId: string, requestId?: string) {
    const ticket = await TicketRepository.restore(id, userId);

    await ActivityService.log({
      userId,
      action: ActivityType.TICKET_RESTORE,
      targetType: "TICKET",
      targetId: id,
      details: {
        ticketNumber: ticket.ticketNumber,
        totalAmount: ticket.totalAmount,
        restored: true,
        description: `Ticket #${ticket.ticketNumber} restaurado (Monto: ₡${ticket.totalAmount.toLocaleString()})`
      },
      requestId,
      layer: "service",
    });

    logger.info({
      layer: "service",
      action: "TICKET_RESTORE",
      userId,
      requestId,
      payload: { ticketId: id },
    });

    return ticket;
  },

  // ==================== MÉTODOS DE PAGO ====================

  /**
   * Registrar un pago (total o parcial) en un ticket ganador
   */
  async registerPayment(
    ticketId: string,
    data: RegisterPaymentInput,
    userId: string,
    requestId?: string
  ) {
    try {
      // Verificar que el ticket existe y es ganador
      const ticket = await withConnectionRetry(
        () => prisma.ticket.findUnique({
          where: { id: ticketId },
          include: { jugadas: true, vendedor: true, ventana: true, sorteo: { select: { id: true, status: true } } },
        }),
        { context: 'TicketService.registerPayment.fetchTicket' }
      );

      if (!ticket) throw new AppError("Ticket no encontrado", 404);
      if (!ticket.isWinner) throw new AppError("El ticket no es ganador", 409);

      //  NUEVA VALIDACIÓN: Verificar que el sorteo no esté cerrado
      if (ticket.sorteo?.status === "CLOSED") {
        throw new AppError(
          "No se pueden registrar pagos para tickets de sorteos cerrados",
          409
        );
      }

      // Validar estado del ticket
      if (ticket.status !== "EVALUATED" && ticket.status !== "PAID") {
        throw new AppError("El ticket debe estar en estado EVALUATED para pagar", 409);
      }

      // Calcular totalPayout (suma de jugadas ganadoras)
      const totalPayout = ticket.jugadas
        .filter((j) => j.isWinner)
        .reduce((acc, j) => acc + (j.payout ?? 0), 0);

      // Validar que no se exceda el monto total
      const currentPaid = ticket.totalPaid ?? 0;
      const newTotal = currentPaid + data.amountPaid;

      if (newTotal > totalPayout) {
        throw new AppError(
          `El pago excede el premio total. Total: ${totalPayout}, Pagado: ${currentPaid}, Intentado: ${data.amountPaid}`,
          400
        );
      }

      // Idempotencia: si ya existe un pago con esta llave, retornar el existente
      if (data.idempotencyKey) {
        const existing = await withConnectionRetry(
          () => prisma.ticketPayment.findUnique({
            where: { idempotencyKey: data.idempotencyKey },
            include: { ticket: true },
          }),
          { context: 'TicketService.registerPayment.idempotency' }
        );
        if (existing) {
          logger.info({
            layer: "service",
            action: "PAYMENT_IDEMPOTENT",
            userId,
            requestId,
            payload: { ticketId, idempotencyKey: data.idempotencyKey },
          });
          return existing.ticket;
        }
      }

      // Calcular si es pago parcial y monto restante
      const isPartial = newTotal < totalPayout;
      const remainingAmount = isPartial ? totalPayout - newTotal : 0;

      // Determinar si el ticket debe marcarse como PAID
      const shouldMarkPaid = !isPartial || data.isFinal;

      // Obtener historial actual
      const currentHistory = (ticket.paymentHistory as any[]) || [];

      // Crear entrada para historial
      const user = await withConnectionRetry(
        () => prisma.user.findUnique({ where: { id: userId } }),
        { context: 'TicketService.registerPayment.fetchUser' }
      );
      const historyEntry: PaymentHistoryEntry = {
        id: crypto.randomUUID(),
        amountPaid: data.amountPaid,
        paidAt: formatDateCRWithTZ(nowCR()), //  Usar formatDateCRWithTZ para timezone explícito
        paidById: userId,
        paidByName: user?.name ?? "Unknown",
        method: data.method ?? "cash",
        notes: data.notes,
        isFinal: data.isFinal ?? false,
        isReversed: false,
      };

      // Actualizar en transacción
      const updated = await withConnectionRetry(
        () => prisma.$transaction(async (tx) => {
          // Crear registro de auditoría en TicketPayment
          await tx.ticketPayment.create({
            data: {
              ticketId,
              amountPaid: data.amountPaid,
              paidById: userId,
              method: data.method ?? "cash",
              notes: data.notes,
              isPartial,
              remainingAmount,
              isFinal: data.isFinal ?? false,
              isReversed: false, // Explícitamente false para nuevo pago
              completedAt: shouldMarkPaid ? new Date() : null,
              idempotencyKey: data.idempotencyKey,
            },
          });

          // Actualizar ticket con información consolidada
          return tx.ticket.update({
            where: { id: ticketId },
            data: {
              totalPayout,
              totalPaid: newTotal,
              remainingAmount,
              lastPaymentAt: new Date(),
              paidById: userId,
              paymentMethod: data.method ?? "cash",
              paymentNotes: data.notes,
              paymentHistory: [...currentHistory, historyEntry] as any,
              status: shouldMarkPaid ? "PAID" : ticket.status,
            },
            include: {
              jugadas: true,
              vendedor: true,
              ventana: true,
              paidBy: true,
              loteria: true,
              sorteo: true,
            },
          });
        }),
        { context: 'TicketService.registerPayment.transaction' }
      );

      // Log de actividad
      await ActivityService.log({
        userId,
        action: ActivityType.TICKET_PAY,
        targetType: "TICKET",
        targetId: ticketId,
        details: {
          ticketNumber: ticket.ticketNumber,
          amountPaid: data.amountPaid,
          totalPaid: newTotal,
          totalPayout,
          remainingAmount,
          isPartial,
          isFinal: data.isFinal,
          newStatus: shouldMarkPaid ? "PAID" : ticket.status,
          description: `Pago de ₡${data.amountPaid.toLocaleString()} registrado para el Ticket #${ticket.ticketNumber}${isPartial ? " (Pago Parcial)" : ""}`,
        },
        requestId,
        layer: "service",
      });

      logger.info({
        layer: "service",
        action: "TICKET_PAYMENT_REGISTERED",
        userId,
        requestId,
        payload: {
          ticketId,
          amountPaid: data.amountPaid,
          totalPaid: newTotal,
          isPartial,
          shouldMarkPaid,
        },
      });

      return updated;
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "TICKET_PAYMENT_FAIL",
        userId,
        requestId,
        payload: { message: err.message },
      });
      throw err;
    }
  },

  /**
   * Revertir el último pago de un ticket
   */
  async reversePayment(ticketId: string, userId: string, reason?: string, requestId?: string) {
    try {
      const ticket = await withConnectionRetry(
        () => prisma.ticket.findUnique({
          where: { id: ticketId },
          include: { jugadas: true },
        }),
        { context: 'TicketService.reversePayment.fetchTicket' }
      );

      if (!ticket) throw new AppError("Ticket no encontrado", 404);

      const history = (ticket.paymentHistory as unknown as PaymentHistoryEntry[]) || [];
      if (history.length === 0) {
        throw new AppError("No hay pagos para revertir", 409);
      }

      // Encontrar el último pago no revertido
      const lastPayment = [...history].reverse().find((p) => !p.isReversed);
      if (!lastPayment) {
        throw new AppError("No hay pagos activos para revertir", 409);
      }

      // Marcar como revertido en historial
      const updatedHistory = history.map((p) =>
        p.id === lastPayment.id
          ? {
            ...p,
            isReversed: true,
            reversedAt: new Date().toISOString(),
            reversedBy: userId,
          }
          : p
      );

      // Recalcular totales
      const activePaid = updatedHistory
        .filter((p) => !p.isReversed)
        .reduce((acc, p) => acc + p.amountPaid, 0);

      const totalPayout = ticket.totalPayout ?? 0;
      const remainingAmount = totalPayout - activePaid;

      // Determinar nuevo estado
      const newStatus = activePaid === 0 ? "EVALUATED" : activePaid >= totalPayout ? "PAID" : ticket.status;

      // Actualizar en transacción
      const updated = await prisma.$transaction(async (tx) => {
        // Marcar el TicketPayment original como revertido
        await tx.ticketPayment.updateMany({
          where: {
            ticketId,
            amountPaid: lastPayment.amountPaid,
            paidById: lastPayment.paidById,
            isReversed: false,
          },
          data: {
            isReversed: true,
            reversedAt: new Date(),
            reversedBy: userId,
          },
        });

        // Actualizar ticket
        return await tx.ticket.update({
          where: { id: ticketId },
          data: {
            totalPaid: activePaid,
            remainingAmount,
            paymentHistory: updatedHistory as any,
            status: newStatus,
            paymentNotes: reason ? `Revertido: ${reason}` : undefined,
          },
          include: {
            jugadas: true,
            vendedor: true,
            ventana: true,
            paidBy: true,
            loteria: true,
            sorteo: true,
          },
        });
      });

      // Log de actividad
      await ActivityService.log({
        userId,
        action: ActivityType.TICKET_PAYMENT_REVERSE,
        targetType: "TICKET",
        targetId: ticketId,
        details: {
          ticketNumber: ticket.ticketNumber,
          amountReversed: lastPayment.amountPaid,
          reason,
          newTotalPaid: activePaid,
          newStatus,
          description: `Pago de ₡${lastPayment.amountPaid.toLocaleString()} revertido para el Ticket #${ticket.ticketNumber}${reason ? ` (Motivo: ${reason})` : ""}`,
        },
        requestId,
        layer: "service",
      });

      logger.warn({
        layer: "service",
        action: "TICKET_PAYMENT_REVERSED",
        userId,
        requestId,
        payload: {
          ticketId,
          amountReversed: lastPayment.amountPaid,
          reason,
        },
      });

      return updated;
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "TICKET_PAYMENT_REVERSE_FAIL",
        userId,
        requestId,
        payload: { message: err.message },
      });
      throw err;
    }
  },

  /**
   * Marcar un pago parcial como final (acepta deuda restante)
   */
  async finalizePayment(ticketId: string, userId: string, notes?: string, requestId?: string) {
    try {
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        include: { jugadas: true },
      });

      if (!ticket) throw new AppError("Ticket no encontrado", 404);

      const history = (ticket.paymentHistory as unknown as PaymentHistoryEntry[]) || [];
      const lastPayment = [...history].reverse().find((p) => !p.isReversed);

      if (!lastPayment) {
        throw new AppError("No hay pagos activos para finalizar", 409);
      }

      if (lastPayment.isFinal) {
        throw new AppError("El último pago ya está marcado como final", 409);
      }

      const totalPaid = ticket.totalPaid ?? 0;
      const totalPayout = ticket.totalPayout ?? 0;

      if (totalPaid >= totalPayout) {
        throw new AppError("El pago ya está completo, no es necesario finalizar", 409);
      }

      // Marcar como final en historial
      const updatedHistory = history.map((p) =>
        p.id === lastPayment.id ? { ...p, isFinal: true, notes: notes ?? p.notes } : p
      );

      // Actualizar ticket
      const updated = await prisma.$transaction(async (tx) => {
        // Actualizar el TicketPayment original
        await tx.ticketPayment.updateMany({
          where: {
            ticketId,
            amountPaid: lastPayment.amountPaid,
            paidById: lastPayment.paidById,
            isReversed: false,
            isFinal: false,
          },
          data: {
            isFinal: true,
            completedAt: new Date(),
            notes: notes ?? undefined,
          },
        });

        // Marcar ticket como PAID
        return await tx.ticket.update({
          where: { id: ticketId },
          data: {
            paymentHistory: updatedHistory as any,
            status: "PAID",
            paymentNotes: notes ?? ticket.paymentNotes,
          },
          include: {
            jugadas: true,
            vendedor: true,
            ventana: true,
            paidBy: true,
            loteria: true,
            sorteo: true,
          },
        });
      });

      // Log de actividad
      await ActivityService.log({
        userId,
        action: ActivityType.TICKET_PAY_FINALIZE,
        targetType: "TICKET",
        targetId: ticketId,
        details: {
          ticketNumber: ticket.ticketNumber,
          totalPaid,
          totalPayout,
          remainingAccepted: totalPayout - totalPaid,
          notes,
          description: `Pago finalizado para el Ticket #${ticket.ticketNumber}. Monto pendiente aceptado: ₡${(totalPayout - totalPaid).toLocaleString()}`,
        },
        requestId,
        layer: "service",
      });

      logger.info({
        layer: "service",
        action: "TICKET_PAYMENT_FINALIZED",
        userId,
        requestId,
        payload: {
          ticketId,
          totalPaid,
          totalPayout,
          remainingAccepted: totalPayout - totalPaid,
        },
      });

      return updated;
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "TICKET_PAYMENT_FINALIZE_FAIL",
        userId,
        requestId,
        payload: { message: err.message },
      });
      throw err;
    }
  },

  /**
   * Obtiene resumen de números dinámicamente (0-99 o 0-999) con montos por tipo (NÚMERO vs REVENTADO)
   * GET /api/v1/tickets/numbers-summary
   */
  async numbersSummary(
    params: {
      date?: string;
      fromDate?: string;
      toDate?: string;
      scope?: string;
      dimension?: string;
      ventanaId?: string | null;
      vendedorId?: string | null;
      loteriaId?: string;
      sorteoId?: string;
      multiplierId?: string; //  NUEVO
      status?: string; //  NUEVO
      sorteoStatus?: string; // Filtrar por estado del sorteo asociado
      page?: number; //  NUEVO: Paginación (0-9 para MONAZOS)
      pageSize?: number; //  NUEVO: Tamaño de página (default: 100)
    },
    role: string,
    userId: string
  ) {
    try {
      //  FIX: Regla especial - cuando hay sorteoId y no hay fechas explícitas, NO aplicar filtros de fecha
      const hasSorteoId = !!params.sorteoId;
      const hasExplicitDateRange = !!(params.fromDate || params.toDate);

      let dateRange: DateRangeResolution | null = null;

      if (hasSorteoId && !hasExplicitDateRange) {
        // NO aplicar filtro de fecha cuando hay sorteoId y no hay fechas explícitas
        dateRange = null;
      } else {
        // Resolver rango de fechas normalmente
        dateRange = resolveDateRange(
          params.date || "today",
          params.fromDate,
          params.toDate
        );
      }

      // Construir filtro para tickets según dimension y scope
      const ticketWhere: any = {
        deletedAt: null,
        //  FIX: Solo aplicar filtro de fecha si dateRange no es null
        ...(dateRange ? {
          businessDate: {
            gte: dateRange.fromBusinessDate,
            lte: dateRange.toBusinessDate,
          },
        } : {}),
        // Excluir tickets CANCELLED por defecto
        // Si se especifica params.status, usar ese valor; si no, excluir CANCELLED
        status: params.status
          ? params.status
          : { notIn: ["CANCELLED", "EXCLUDED"] }, // Excluir CANCELLED si no se especifica
        isActive: true,
        ...(params.sorteoStatus ? { sorteo: { status: params.sorteoStatus } } : {}),
        ...(params.loteriaId ? { loteriaId: params.loteriaId } : {}),
        ...(params.sorteoId ? { sorteoId: params.sorteoId } : {}),
      };

      //  NUEVO: Aplicar exclusión de listas si hay sorteoId
      if (params.sorteoId) {
        const exclusionCondition = await getExclusionWhereCondition(params.sorteoId);
        Object.assign(ticketWhere, exclusionCondition);
      }

      //  FIX: Si hay multiplierId, filtrar tickets que tengan al menos una jugada NUMERO con ese multiplierId
      // Esto asegura que los REVENTADO incluidos estén en los mismos tickets que los NUMERO filtrados
      if (params.multiplierId) {
        ticketWhere.jugadas = {
          some: {
            multiplierId: params.multiplierId,
            type: 'NUMERO',
            deletedAt: null,
            isActive: true,
            isExcluded: false,
          },
        };
      }

      // Aplicar filtros según dimension y scope
      // FIX: Los filtros son INDEPENDIENTES y ACUMULATIVOS (AND lógico)

      // 1. Validar dimension (si se especifica, requiere el filtro correspondiente)
      if (params.dimension === "listero" && !params.ventanaId) {
        throw new AppError("ventanaId es requerido cuando dimension='listero'", 400);
      }
      if (params.dimension === "vendedor" && !params.vendedorId) {
        throw new AppError("vendedorId es requerido cuando dimension='vendedor'", 400);
      }

      // 2. Aplicar filtros de forma INDEPENDIENTE (no else if)
      // Cada filtro se aplica si está presente, permitiendo combinaciones
      if (params.ventanaId) {
        ticketWhere.ventanaId = params.ventanaId;
      }

      if (params.vendedorId) {
        ticketWhere.vendedorId = params.vendedorId;
      }

      // 3. Si scope='mine' y NO hay filtros explícitos, aplicar filtro según rol
      if (params.scope === "mine" && !params.ventanaId && !params.vendedorId) {
        if (role === "VENDEDOR") {
          ticketWhere.vendedorId = userId;
        } else if (role === "VENTANA") {
          logger.warn({
            layer: "service",
            action: "TICKET_NUMBERS_SUMMARY_MISSING_VENTANA_ID",
            payload: { role, userId, message: "VENTANA user should have ventanaId from RBAC" },
          });
        }
      }
      // Si scope='all' y no hay filtros específicos, no agregar filtros de ventanaId/vendedorId (admin ve todo)

      //  NUEVO: Obtener sorteo/lotería para detectar digits y reventadoEnabled
      let sorteoDigits = 2; // Default
      let sorteoName = '';
      let reventadoEnabled = true; // Default (asumir habilitado si no se puede determinar)
      let multiplierName = '';

      //  NUEVO: Obtener nombre del multiplicador si está presente
      if (params.multiplierId) {
        const multiplier = await withConnectionRetry(
          () => prisma.loteriaMultiplier.findUnique({
            where: { id: params.multiplierId! },
            select: { name: true },
          }),
          { context: 'TicketService.numbersSummary.multiplier' }
        );
        multiplierName = multiplier?.name || '';
      }

      //  NUEVO: Variable para almacenar información de números ganadores
      let winningNumbersInfo: {
        sorteoId: string;
        sorteoName: string;
        sorteoStatus: string;
        isEvaluated: boolean;
        digits: number;
        winners: Array<{
          number: string;
          position: number;
          prizeType: string;
        }>;
      } | undefined = undefined;

      if (params.sorteoId) {
        const sorteo = await withConnectionRetry(
          () => prisma.sorteo.findUnique({
            where: { id: params.sorteoId! },
            select: {
              id: true,
              name: true,
              status: true,
              winningNumber: true, //  NUEVO: Obtener número ganador
              loteria: {
                select: {
                  rulesJson: true,
                },
              },
            },
          }),
          { context: 'TicketService.numbersSummary.sorteo' }
        );
        sorteoName = sorteo?.name || '';

        // Extraer reventadoEnabled y digits de loteriaRules
        const loteriaRules = sorteo?.loteria?.rulesJson as any;
        reventadoEnabled = loteriaRules?.reventadoConfig?.enabled ?? true;

        //  Usar resolveDigits para obtener digits desde rulesJson
        const { resolveDigits } = await import('../../../utils/loteriaRules');
        sorteoDigits = resolveDigits(loteriaRules, 2);

        //  NUEVO: Si el sorteo está evaluado y tiene número ganador, preparar info
        if (sorteo && sorteo.status === 'EVALUATED' && sorteo.winningNumber) {
          winningNumbersInfo = {
            sorteoId: sorteo.id,
            sorteoName: sorteo.name,
            sorteoStatus: sorteo.status,
            isEvaluated: true,
            digits: sorteoDigits,
            winners: [
              {
                number: sorteo.winningNumber.padStart(sorteoDigits, '0'),
                position: 1,
                prizeType: 'PRIMERO',
              }
            ]
          };

          logger.info({
            layer: "service",
            action: "TICKET_NUMBERS_SUMMARY_WINNING_NUMBER",
            payload: {
              sorteoId: sorteo.id,
              sorteoName: sorteo.name,
              winningNumber: sorteo.winningNumber,
              digits: sorteoDigits,
            },
          });
        }
      } else if (params.loteriaId) {
        // Si solo hay loteriaId (sin sorteoId), consultar la lotería
        const loteria = await prisma.loteria.findUnique({
          where: { id: params.loteriaId },
          select: { rulesJson: true }
        });

        const loteriaRules = loteria?.rulesJson as any;
        reventadoEnabled = loteriaRules?.reventadoConfig?.enabled ?? true;

        //  Usar resolveDigits para obtener digits desde rulesJson
        const { resolveDigits } = await import('../../../utils/loteriaRules');
        sorteoDigits = resolveDigits(loteriaRules, 2);
      }

      //  Calcular rango dinámico basado en digits
      const maxNumber = Math.pow(10, sorteoDigits) - 1; // 2 digits -> 99, 3 digits -> 999

      //  OPTIMIZED: Fetch tickets with jugadas and metadata in a single query
      // Build jugada filter for nested query
      //  CRÍTICO: NO filtrar por multiplierId aquí, ya que el filtro se aplica a nivel de ticket
      // Esto permite incluir TANTO las jugadas NUMERO con el multiplierId especificado
      // COMO las jugadas REVENTADO que van automáticamente con ellas en el mismo ticket
      const jugadaFilter: any = {
        deletedAt: null,
        isActive: true,
        isExcluded: false, //  FIX: Excluir jugadas marcadas como excluidas
      };

      //  OPTIMIZED: SQL Aggregation using $queryRaw
      // This solves the 'too many bind variables' error and reduces memory usage.
      const sqlJoins: Prisma.Sql[] = [];
      if (params.sorteoStatus) {
        sqlJoins.push(Prisma.sql`INNER JOIN "Sorteo" s ON t."sorteoId" = s.id`);
      }
      const joinsSQL = sqlJoins.length > 0 ? Prisma.join(sqlJoins, ' ') : Prisma.empty;

      const sqlWhere: Prisma.Sql[] = [
        Prisma.sql`t."deletedAt" IS NULL`,
        Prisma.sql`t."isActive" = true`
      ];

      if (params.sorteoStatus) {
        sqlWhere.push(Prisma.sql`s.status::text = ${params.sorteoStatus}`);
      }

      // Filter by status (default not in CANCELLED/EXCLUDED)
      if (params.status) {
        sqlWhere.push(Prisma.sql`t."status" = ${params.status}`);
      } else {
        sqlWhere.push(Prisma.sql`t."status" NOT IN ('CANCELLED', 'EXCLUDED')`);
      }

      // Filter by businessDate (uses idx_ticket_cierre_consolidado)
      if (dateRange) {
        sqlWhere.push(Prisma.sql`t."businessDate" BETWEEN ${dateRange.fromBusinessDate}::date AND ${dateRange.toBusinessDate}::date`);
      }

      // Other ticket filters
      if (params.loteriaId) sqlWhere.push(Prisma.sql`t."loteriaId" = CAST(${params.loteriaId} AS uuid)`);
      if (params.sorteoId) sqlWhere.push(Prisma.sql`t."sorteoId" = CAST(${params.sorteoId} AS uuid)`);
      if (params.ventanaId) sqlWhere.push(Prisma.sql`t."ventanaId" = CAST(${params.ventanaId} AS uuid)`);

      // Role-based filters
      if (params.vendedorId) {
        sqlWhere.push(Prisma.sql`t."vendedorId" = CAST(${params.vendedorId} AS uuid)`);
      } else if (params.scope === "mine" && role === "VENDEDOR") {
        sqlWhere.push(Prisma.sql`t."vendedorId" = CAST(${userId} AS uuid)`);
      }

      // Excluir listas si hay sorteoId
      if (params.sorteoId) {
        const exclusionCondition = await getExclusionWhereCondition(params.sorteoId);
        if (exclusionCondition.NOT?.OR) {
          const exclusions = exclusionCondition.NOT.OR.map((ex: any) => {
            let cond = Prisma.sql`t."ventanaId" = CAST(${ex.ventanaId} AS uuid)`;
            if (ex.vendedorId) cond = Prisma.sql`${cond} AND t."vendedorId" = CAST(${ex.vendedorId} AS uuid)`;
            
            //  NUEVO: Soporte para exclusión por multiplierId (banda específica)
            if (ex.multiplierId) {
              cond = Prisma.sql`${cond} AND EXISTS (
                SELECT 1 FROM "Jugada" j_ex 
                WHERE j_ex."ticketId" = t.id 
                AND j_ex."multiplierId" = CAST(${ex.multiplierId} AS uuid)
                AND j_ex."deletedAt" IS NULL
              )`;
            }
            return Prisma.sql`(${cond})`;
          });
          sqlWhere.push(Prisma.sql`NOT (${Prisma.join(exclusions, ' OR ')})`);
        }
      }

      const combinedWhere = Prisma.join(sqlWhere, ' AND ');

      // Build main query
      // If multiplierId is present, we filter tickets that have at least one NUMERO with that multiplier
      const multiplierFilterTicket = params.multiplierId
        ? Prisma.sql`AND EXISTS (
            SELECT 1 FROM "Jugada" j2 
            WHERE j2."ticketId" = t.id 
              AND j2."multiplierId" = CAST(${params.multiplierId} AS uuid)
              AND j2.type = 'NUMERO'
              AND j2."isActive" = true 
              AND j2."deletedAt" IS NULL
          )`
        : Prisma.empty;

      const results = await prisma.$queryRaw<any[]>`
        SELECT 
          j.number,
          SUM(CASE WHEN j.type = 'NUMERO' ${params.multiplierId ? Prisma.sql`AND j."multiplierId" = CAST(${params.multiplierId} AS uuid)` : Prisma.empty} THEN j.amount ELSE 0 END)::FLOAT as "amountByNumber",
          SUM(CASE WHEN j.type = 'REVENTADO' THEN j.amount ELSE 0 END)::FLOAT as "amountByReventado",
          COUNT(DISTINCT t.id)::INT as "ticketCount",
          COUNT(DISTINCT CASE WHEN j.type = 'NUMERO' THEN t.id END)::INT as "ticketsByNumber",
          COUNT(DISTINCT CASE WHEN j.type = 'REVENTADO' THEN t.id END)::INT as "ticketsByReventado",
          SUM(CASE WHEN j.type = 'NUMERO' ${params.multiplierId ? Prisma.sql`AND j."multiplierId" = CAST(${params.multiplierId} AS uuid)` : Prisma.empty} 
            THEN ${params.dimension === 'listero' || params.ventanaId ? Prisma.sql`j."listeroCommissionAmount"` : Prisma.sql`j."commissionAmount"`} 
            ELSE 0 END)::FLOAT as "commissionByNumber",
          SUM(CASE WHEN j.type = 'REVENTADO' 
            THEN ${params.dimension === 'listero' || params.ventanaId ? Prisma.sql`j."listeroCommissionAmount"` : Prisma.sql`j."commissionAmount"`} 
            ELSE 0 END)::FLOAT as "commissionByReventado"
        FROM "Ticket" t
        ${joinsSQL}
        INNER JOIN "Jugada" j ON t.id = j."ticketId"
        WHERE ${combinedWhere}
          AND j."isActive" = true 
          AND j."deletedAt" IS NULL
          AND j."isExcluded" = false
          ${multiplierFilterTicket}
        GROUP BY j.number
      `;

      //  NUEVO: Extraer metadatos de las tablas maestras cuando se filtran (Hardening BE-1)
      // Esto asegura que tengamos nombres correctos incluso si no hay tickets (lista vacía)
      let metadataInfo: any = {};

      const masterTasks: (() => Promise<any>)[] = [];
      if (params.ventanaId) {
        masterTasks.push(() => prisma.ventana.findUnique({ where: { id: params.ventanaId! }, select: { name: true } }));
      }
      if (params.vendedorId) {
        masterTasks.push(() => prisma.user.findUnique({ where: { id: params.vendedorId! }, select: { name: true, code: true } }));
      }
      if (params.loteriaId) {
        masterTasks.push(() => prisma.loteria.findUnique({ where: { id: params.loteriaId! }, select: { name: true } }));
      }
      if (params.sorteoId) {
        masterTasks.push(() => prisma.sorteo.findUnique({ where: { id: params.sorteoId! }, select: { scheduledAt: true } }));
      }

      const masterResults = await Promise.all(masterTasks.map(t => t()));
      let nextResultIdx = 0;

      if (params.ventanaId) {
        metadataInfo.ventanaName = masterResults[nextResultIdx++]?.name;
      }
      if (params.vendedorId) {
        const v = masterResults[nextResultIdx++];
        metadataInfo.vendedorName = v?.name;
        metadataInfo.vendedorCode = v?.code;
      }
      if (params.loteriaId) {
        metadataInfo.loteriaName = masterResults[nextResultIdx++]?.name;
      }
      if (params.sorteoId) {
        metadataInfo.sorteoDate = masterResults[nextResultIdx++]?.scheduledAt;
      }

      //  NUEVO: Si hay tickets, podemos complementar datos faltantes o usar los del primer ticket
      // Pero priorizamos los datos de los parámetros de filtro si están presentes
      if (results.length > 0 && (!metadataInfo.ventanaName || !metadataInfo.vendedorName)) {
        const firstTicket = await withConnectionRetry(
          () => prisma.ticket.findFirst({
            where: ticketWhere,
            select: {
              ventana: { select: { name: true } },
              vendedor: { select: { name: true, code: true } },
              loteria: { select: { name: true } },
              sorteo: { select: { scheduledAt: true } }
            }
          }),
          { context: 'TicketService.numbersSummary.metadata' }
        );

        if (!metadataInfo.ventanaName) metadataInfo.ventanaName = firstTicket?.ventana?.name;
        if (!metadataInfo.vendedorName && params.vendedorId) {
          metadataInfo.vendedorName = firstTicket?.vendedor?.name;
          metadataInfo.vendedorCode = firstTicket?.vendedor?.code;
        }
        if (!metadataInfo.loteriaName) metadataInfo.loteriaName = firstTicket?.loteria?.name;
        if (!metadataInfo.sorteoDate) metadataInfo.sorteoDate = firstTicket?.sorteo?.scheduledAt;
      }

      //  CRÍTICO: Si dimension='listero', QUITAR el vendedorName de los metadatos
      // Esto asegura que pdf-generator.service.ts use ventanaName (ver l.122 de pdf-generator.ts)
      if (params.dimension === 'listero') {
        delete metadataInfo.vendedorName;
        delete metadataInfo.vendedorCode;
      }

      // Map results to Map for quick lookup
      const numbersMap = new Map<string, any>();
      let totalAmountByNumber = 0;
      let totalAmountByReventado = 0;
      let commissionByNumber = 0;
      let commissionByReventado = 0;
      const numbersWithBetsSet = new Set<string>();

      for (const row of results) {
        const numStr = row.number.padStart(sorteoDigits, '0');
        // Validar rango dinámico
        const numValue = parseInt(numStr, 10);
        if (numValue < 0 || numValue > maxNumber) continue;

        numbersMap.set(numStr, row);
        totalAmountByNumber += row.amountByNumber || 0;
        totalAmountByReventado += row.amountByReventado || 0;
        commissionByNumber += row.commissionByNumber || 0;
        commissionByReventado += row.commissionByReventado || 0;
        
        if (row.amountByNumber > 0 || row.amountByReventado > 0) {
          numbersWithBetsSet.add(numStr);
        }
      }

      //  Determinar rango de números a retornar (paginación)
      const pageSize = params.pageSize || 100;
      const page = params.page;
      let startNumber = 0;
      let endNumber = maxNumber;

      if (page !== undefined) {
        startNumber = page * pageSize;
        endNumber = Math.min(startNumber + pageSize - 1, maxNumber);
      }

      //  Construir array de respuesta
      const data = Array.from({ length: endNumber - startNumber + 1 }, (_, i) => {
        const numValue = startNumber + i;
        const numStr = String(numValue).padStart(sorteoDigits, '0');
        const row = numbersMap.get(numStr) || {
          amountByNumber: 0,
          amountByReventado: 0,
          ticketCount: 0,
          ticketsByNumber: 0,
          ticketsByReventado: 0,
        };

        return {
          number: numStr,
          amountByNumber: Number(row.amountByNumber),
          amountByReventado: Number(row.amountByReventado),
          totalAmount: Number(row.amountByNumber) + Number(row.amountByReventado),
          ticketCount: Number(row.ticketCount),
          ticketsByNumber: Number(row.ticketsByNumber),
          ticketsByReventado: Number(row.ticketsByReventado),
        };
      });

      // Total tickets count (requires separate query to be accurate if grouping by number)
      const { _count: totalTickets } = await prisma.ticket.aggregate({
        where: ticketWhere,
        _count: true,
      });

      const numbersWithBets = Array.from(numbersWithBetsSet).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

      return {
        data,
        meta: {
          dateFilter: params.date || "today",
          ...(params.fromDate ? { fromDate: params.fromDate } : {}),
          ...(params.toDate ? { toDate: params.toDate } : {}),
          totalNumbers: maxNumber + 1,
          sorteoDigits,
          maxNumber,
          reventadoEnabled,
          ...(sorteoName ? { sorteoName } : {}),
          ...(multiplierName ? { multiplierName } : {}),
          ...(page !== undefined ? {
            pagination: {
              page,
              pageSize,
              startNumber,
              endNumber,
              totalPages: Math.ceil((maxNumber + 1) / pageSize),
              returnedCount: data.length,
            }
          } : {}),
          totalAmountByNumber,
          totalAmountByReventado,
          totalAmount: totalAmountByNumber + totalAmountByReventado,
          totalTickets,
          commissionByNumber,
          commissionByReventado,
          totalCommission: commissionByNumber + commissionByReventado,
          numbersWithBets,
          ...(winningNumbersInfo ? { winningNumbers: winningNumbersInfo } : {}),
          ...(params.dimension ? { dimension: params.dimension } : {}),
          ...(params.ventanaId ? { ventanaId: params.ventanaId } : {}),
          ...(params.vendedorId ? { vendedorId: params.vendedorId } : {}),
          ...metadataInfo,
        },
      };
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "TICKET_NUMBERS_SUMMARY_FAIL",
        payload: { message: err.message, params },
      });
      throw err;
    }
  },

  /**
   * Resuelve los multiplicadores a usar en el batch (por sorteo o lotería)
   */
  async resolveMultipliersForBatch(params: { loteriaId?: string | null; sorteoId?: string | null; multiplierIds?: string[] }) {
    let loteriaId = params.loteriaId;
    if (!loteriaId && params.sorteoId) {
      const sorteo = await prisma.sorteo.findUnique({
        where: { id: params.sorteoId },
        select: { loteriaId: true },
      });
      loteriaId = sorteo?.loteriaId || null;
    }

    if (!loteriaId) {
      throw new AppError("Se requiere loteriaId o sorteoId para groupBy=multiplier", 400);
    }

    const multipliers = await prisma.loteriaMultiplier.findMany({
      where: {
        loteriaId,
        ...(params.multiplierIds && params.multiplierIds.length > 0 ? { id: { in: params.multiplierIds } } : {}),
      },
      select: { id: true, name: true, valueX: true },
      orderBy: { valueX: "desc" },
    });

    return multipliers;
  },

  /**
   * Batch numbers summary por multiplicador: genera PDF único (y opcionalmente PNGs)
   */
  async numbersSummaryBatch(
    params: any,
    role: string,
    userId: string,
    format: 'pdf' | 'png' = 'png'
  ) {
    try {
      const multipliers: Array<{ id: string; name: string; valueX: number | null }> = params.multipliers || [];
      if (!multipliers.length) {
        throw new AppError("No hay multiplicadores para procesar", 400);
      }

      // Solo soportamos PNG para batch
      if (format !== 'png') {
        throw new AppError("Solo se admite format='png' en batch", 400);
      }

      const { generateNumbersSummaryPDF } = await import('./pdf-generator.service');
      const { pdfToPng } = await import('pdf-to-png-converter');

      const pages: Array<{
        page: number;
        filename: string;
        image: string;
        multiplierId: string;
        multiplierName: string;
        multiplierValue: number | null;
      }> = [];

      //  OPTIMIZED: Procesar todos los multiplicadores en paralelo para evitar 503 Timeout
      // Usamos Promise.all para que todas las generaciones ocurran concurrentemente
      const batchPromises = multipliers.map(async (multiplier) => {
        const result = await TicketService.numbersSummary(
          {
            ...params,
            multiplierId: multiplier.id,
          },
          role,
          userId
        );

        // Generar PDF por multiplicador
        const pdfBuffer = await generateNumbersSummaryPDF({
          meta: {
            ...result.meta,
            multiplierName: multiplier.name,
          },
          numbers: result.data,
        });

        const doc = await PDFDocument.load(pdfBuffer);
        const pageCount = doc.getPageCount();

        // Convertir todas las páginas a PNG
        const pngPages = await pdfToPng(new Uint8Array(pdfBuffer).buffer, {
          pagesToProcess: Array.from({ length: pageCount }, (_, i) => i + 1),
        });

        if (!pngPages || pngPages.length === 0) {
          throw new AppError(`No se pudo generar PNG para el multiplicador ${multiplier.name}`, 422);
        }

        return pngPages
          .filter(p => p && p.content)
          .map((p, idx) => {
            const buffer = p.content as Buffer;
            if (!buffer) return null;
            return {
              page: idx,
              filename: `lista-${multiplier.name || multiplier.valueX || 'mult'}-${idx + 1}.png`,
              image: buffer.toString('base64'),
              multiplierId: multiplier.id,
              multiplierName: multiplier.name,
              multiplierValue: multiplier.valueX,
            };
          })
          .filter(Boolean) as any[];
      });

      const allPagesResults = await Promise.all(batchPromises);
      
      // Aplanar resultados
      allPagesResults.forEach(multiplierPages => {
        pages.push(...multiplierPages);
      });

      return {
        format: 'png',
        pages,
        meta: { multipliers: multipliers.length, totalPages: pages.length },
      };
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "TICKET_NUMBERS_SUMMARY_BATCH_FAIL",
        payload: { message: err.message, params },
      });
      throw err;
    }
  },

  /**
   * Obtiene las jugadas de un ticket existente mediante su número de ticket
   * GET /api/v1/tickets/by-number/:ticketNumber
   * Endpoint público/inter-vendedor (no filtra por vendedor)
   * 
   * Para jugadas REVENTADO, devuelve:
   * - amount: Monto de la jugada NUMERO asociada (número base)
   * - amountReventado: Monto de la jugada REVENTADO
   */
  async getByTicketNumber(ticketNumber: string) {
    try {
      // Buscar el ticket por número (sin filtrar por vendedor)
      const ticket = await prisma.ticket.findUnique({
        where: {
          ticketNumber,
          deletedAt: null, // Solo tickets no eliminados
        },
        select: {
          id: true,
          ticketNumber: true,
          sorteoId: true,
          loteriaId: true,
          createdAt: true,
          clienteNombre: true,
          jugadas: {
            where: {
              deletedAt: null, // Solo jugadas no eliminadas
            },
            select: {
              id: true,
              type: true,
              number: true,
              reventadoNumber: true,
              amount: true,
              multiplierId: true,
            },
            orderBy: {
              createdAt: "asc", // Ordenar por orden de creación
            },
          },
        },
      });

      if (!ticket) {
        throw new AppError(
          `No se encontró un ticket con el número ${ticketNumber}`,
          404,
          "TICKET_NOT_FOUND"
        );
      }

      // Separar jugadas NUMERO y REVENTADO para poder hacer el matching
      const jugadasNumero = ticket.jugadas.filter((j) => j.type === "NUMERO");
      const jugadasReventado = ticket.jugadas.filter((j) => j.type === "REVENTADO");

      // Crear un mapa de números a montos y multiplierId para jugadas NUMERO
      const numeroDataMap = new Map<string, { amount: number; multiplierId: string | null }>();
      jugadasNumero.forEach((j) => {
        numeroDataMap.set(j.number, {
          amount: j.amount,
          multiplierId: j.multiplierId,
        });
      });

      // Crear un Set de números que tienen REVENTADO asociado
      const numerosConReventado = new Set<string>();
      jugadasReventado.forEach((j) => {
        if (j.number) {
          numerosConReventado.add(j.number);
        }
      });

      // Formatear jugadas para el frontend
      // Agrupar: si hay NUMERO + REVENTADO del mismo número, devolver solo REVENTADO con ambos montos
      const jugadas: any[] = [];

      // Procesar jugadas NUMERO que NO tienen REVENTADO asociado
      jugadasNumero.forEach((jugada) => {
        if (!numerosConReventado.has(jugada.number)) {
          // Jugada NUMERO sin REVENTADO: devolver normalmente
          const baseJugada: any = {
            type: "NUMERO",
            number: jugada.number,
            amount: jugada.amount,
          };

          if (jugada.multiplierId) {
            baseJugada.multiplierId = jugada.multiplierId;
          }

          jugadas.push(baseJugada);
        }
        // Si tiene REVENTADO asociado, se procesará en el siguiente loop
      });

      // Procesar jugadas REVENTADO (agrupadas con NUMERO si existe)
      jugadasReventado.forEach((jugada) => {
        const baseJugada: any = {
          type: "REVENTADO",
          number: jugada.number,
          reventadoNumber: jugada.reventadoNumber || jugada.number,
        };

        // Buscar la jugada NUMERO asociada para obtener el monto del número base
        const numeroData = numeroDataMap.get(jugada.number);
        if (numeroData !== undefined) {
          // amount: monto del número base (jugada NUMERO)
          // amountReventado: monto del reventado (jugada REVENTADO)
          baseJugada.amount = numeroData.amount;
          baseJugada.amountReventado = jugada.amount;

          // Incluir multiplierId de la jugada NUMERO asociada
          if (numeroData.multiplierId) {
            baseJugada.multiplierId = numeroData.multiplierId;
          }
        } else {
          // Si no hay jugada NUMERO asociada, usar el amount de REVENTADO como total
          // Esto puede pasar en tickets antiguos o mal formados
          baseJugada.amount = jugada.amount;
          baseJugada.amountReventado = jugada.amount; // Fallback: usar el mismo monto
        }

        jugadas.push(baseJugada);
      });

      return {
        ticketNumber: ticket.ticketNumber,
        jugadas,
        sorteoId: ticket.sorteoId,
        loteriaId: ticket.loteriaId,
        clienteNombre: ticket.clienteNombre,
        createdAt: ticket.createdAt.toISOString(),
      };
    } catch (err: any) {
      // Si es un AppError, re-lanzarlo tal cual
      if (err instanceof AppError) {
        throw err;
      }

      // Para otros errores, loggear y lanzar error genérico
      logger.error({
        layer: "service",
        action: "TICKET_GET_BY_NUMBER_FAIL",
        payload: { message: err.message, ticketNumber },
      });

      throw new AppError(
        "Error al obtener el ticket",
        500,
        "INTERNAL_ERROR"
      );
    }
  },

  /**
   * Obtiene las opciones disponibles para los filtros de tickets
   * basándose en los tickets reales del usuario según su rol
   * GET /api/v1/tickets/filter-options
   */
  async getFilterOptions(params: {
    scope?: string;
    vendedorId?: string;
    ventanaId?: string;
    date?: string;
    fromDate?: string;
    toDate?: string;
    status?: string;
    loteriaId?: string;
    sorteoId?: string;
    multiplierId?: string;
  }, context: {
    userId: string;
    role: Role;
    ventanaId?: string | null;
    bancaId?: string | null;
  }) {
    //  FASE BE-2: Implementación de Cache-Aside con Coalescing
    const cacheKey = `banca:${context.bancaId || 'all'}:ventana:${context.ventanaId || 'all'}:user:${context.userId}:filters:${crypto
      .createHash('md5')
      .update(JSON.stringify({ params, context }))
      .digest('hex')}`;

    const tags = ['ticket:filter-options', `user:${context.userId}`];
    if (context.bancaId) tags.push(`banca:${context.bancaId}`);
    if (params.sorteoId) tags.push(`sorteo:${params.sorteoId}`);

    return CacheService.wrap(
      cacheKey,
      async () => {
        try {
          // Aplicar RBAC filters para determinar qué tickets puede ver el usuario
          const { applyRbacFilters } = require('../../../utils/rbac');
          const authContext = {
            userId: context.userId,
            role: context.role,
            ventanaId: context.ventanaId,
            bancaId: context.bancaId,
          };

          const effectiveFilters = await applyRbacFilters(authContext, {
            scope: params.scope || 'mine',
            vendedorId: params.vendedorId,
            ventanaId: params.ventanaId,
          });

          // Construir filtros de fecha si se proporcionan
          // Regla: cuando hay sorteoId y no hay fechas explícitas, no aplicar filtro de fecha
          let dateFrom: Date | undefined;
          let dateTo: Date | undefined;

          const hasSorteoId = !!params.sorteoId;
          const hasExplicitDateRange = !!(params.fromDate || params.toDate);

          if (!hasSorteoId || hasExplicitDateRange) {
            if (params.date || params.fromDate || params.toDate) {
              const dateRange = resolveDateRange(
                params.date || 'today',
                params.fromDate,
                params.toDate
              );
              dateFrom = dateRange.fromBusinessDate;
              dateTo = dateRange.toBusinessDate;
            }
          }

          // Construir where clause para tickets
          const where: any = {
            deletedAt: null,
            isActive: true,
          };

          // Aplicar filtros RBAC
          if (effectiveFilters.vendedorId) {
            where.vendedorId = effectiveFilters.vendedorId;
          }
          if (effectiveFilters.ventanaId) {
            where.ventanaId = effectiveFilters.ventanaId;
          }
          if (effectiveFilters.bancaId) {
            where.ventana = { bancaId: effectiveFilters.bancaId };
          }

          // Aplicar filtros de lotería, sorteo y multiplicador
          if (params.loteriaId) {
            where.loteriaId = params.loteriaId;
          }
          if (params.sorteoId) {
            where.sorteoId = params.sorteoId;
          }
          if (params.multiplierId) {
            where.jugadas = {
              some: {
                multiplierId: params.multiplierId,
                deletedAt: null,
                isActive: true,
              },
            };
          }

          // Aplicar filtros de fecha
          if (dateFrom || dateTo) {
            where.businessDate = {};
            if (dateFrom) where.businessDate.gte = dateFrom;
            if (dateTo) where.businessDate.lte = dateTo;
          }

          // Aplicar filtro de estado
          // WINNERS_PENDING es un valor sintético del FE que se traduce a isWinner=true + status=EVALUATED
          if (params.status) {
            if (params.status === 'WINNERS_PENDING') {
              where.isWinner = true;
              where.status = 'EVALUATED';
            } else {
              where.status = params.status;
            }
          }

          //  C3.4 OPTIMIZACIÓN: Evitar cargar todos los tickets en memoria para agrupar (Hardening BE-1).
          // Usar ConcurrencyManager para ejecutar queries de agregación en paralelo limitado.
          const initialTasks: (() => Promise<any>)[] = [
            () => prisma.ticket.count({ where }),
            () => prisma.ticket.groupBy({
              by: ['loteriaId'],
              where,
              _count: { id: true }
            }),
            () => prisma.ticket.groupBy({
              by: ['sorteoId'],
              where,
              _count: { id: true }
            })
          ];

          if (context.role === Role.ADMIN || context.role === Role.VENTANA) {
            initialTasks.push(() => prisma.ticket.groupBy({
              by: ['vendedorId'],
              where,
              _count: { id: true }
            }));
            
            //  NUEVO: GroupBy por ventanaId para el filtro de Listeros
            initialTasks.push(() => prisma.ticket.groupBy({
              by: ['ventanaId'],
              where,
              _count: { id: true }
            }));
          }

          initialTasks.push(() => prisma.jugada.groupBy({
            by: ['multiplierId'],
            where: {
              ticket: { ...where },
              deletedAt: null,
              isActive: true,
              type: 'NUMERO',
              multiplierId: { not: null }
            },
            _count: { ticketId: true }
          }));

          const results = await ConcurrencyManager.runLimited(initialTasks, { limit: 2, label: 'ticket-filter-options-init' });
          
          const totalTickets = results[0] as number;
          const loteriaGroups = results[1] as any[];
          const sorteoGroups = results[2] as any[];
          let nextIdx = 3;
          let vendedorGroups: any[] = [];
          let ventanaGroups: any[] = [];
          
          if (context.role === Role.ADMIN || context.role === Role.VENTANA) {
            vendedorGroups = results[nextIdx++] as any[];
            ventanaGroups = results[nextIdx++] as any[];
          }
          const multiplierGroups = results[nextIdx] as any[];

          // Fase 2: Obtener información de las entidades maestras en paralelo limitado
          const masterTasks: (() => Promise<any>)[] = [
            () => prisma.loteria.findMany({
              where: { id: { in: loteriaGroups.map(g => g.loteriaId).filter(id => !!id) } },
              select: { id: true, name: true }
            }),
            () => prisma.sorteo.findMany({
              where: { id: { in: sorteoGroups.map(g => g.sorteoId).filter(id => !!id) } },
              select: { id: true, name: true, scheduledAt: true, loteriaId: true, loteria: { select: { name: true } } }
            }),
            () => prisma.loteriaMultiplier.findMany({
              where: { id: { in: multiplierGroups.map(g => g.multiplierId).filter(id => !!id) }, isActive: true },
              select: { id: true, name: true, valueX: true, loteriaId: true, loteria: { select: { id: true, name: true } } }
            })
          ];

          if (vendedorGroups.length > 0) {
            masterTasks.push(() => prisma.user.findMany({
              where: { id: { in: vendedorGroups.map(g => g.vendedorId).filter(id => !!id) } },
              select: { id: true, name: true, ventanaId: true, ventana: { select: { id: true, name: true } } }
            }));
          }

          if (ventanaGroups.length > 0) {
            masterTasks.push(() => prisma.ventana.findMany({
              where: { id: { in: ventanaGroups.map(g => g.ventanaId).filter(id => !!id) } },
              select: { id: true, name: true, code: true }
            }));
          }

          const masterResults = await ConcurrencyManager.runLimited(masterTasks, { limit: 2, label: 'ticket-filter-options-masters' });
          const loteriasMaster = masterResults[0] as any[];
          const sorteosMaster = masterResults[1] as any[];
          const multipliers = masterResults[2] as any[];
          let masterNextIdx = 3;
          const vendedoresMaster = (vendedorGroups.length > 0) ? masterResults[masterNextIdx++] as any[] : [];
          const ventanasMaster = (ventanaGroups.length > 0) ? masterResults[masterNextIdx] as any[] : [];

          // Fase 3: Para vendedores, filtrar multiplicadores según política de comisión
          let allowedMultiplierIds: Set<string> | null = null;
          if (context.role === Role.VENDEDOR && multipliers.length > 0) {
            const loteriasConMultipliers = Array.from(new Set(multipliers.map(m => m.loteriaId).filter(id => !!id)));
            allowedMultiplierIds = new Set<string>();

            const allowedTasks: (() => Promise<any>)[] = [];
            loteriasConMultipliers.forEach(loteriaId => {
              allowedTasks.push(() => UserService.getAllowedMultipliers(context.userId, loteriaId as string, 'NUMERO'));
              allowedTasks.push(() => UserService.getAllowedMultipliers(context.userId, loteriaId as string, 'REVENTADO'));
            });

            const allowedResults = await ConcurrencyManager.runLimited(allowedTasks, { limit: 2, label: 'ticket-filter-options-allowed' });
            allowedResults.forEach(res => {
              res.data.forEach((m: any) => allowedMultiplierIds!.add(m.id));
            });
          }

          // Fase 4: Construir respuesta mapeando los counts de las agrupaciones
          const loterias = loteriasMaster.map(l => ({
            id: l.id,
            name: l.name,
            ticketCount: loteriaGroups.find(g => g.loteriaId === l.id)?._count.id || 0
          })).sort((a, b) => a.name.localeCompare(b.name));

          const sorteos = sorteosMaster.map(s => ({
            id: s.id,
            name: s.name,
            loteriaId: s.loteriaId,
            loteriaName: s.loteria?.name || '',
            scheduledAt: s.scheduledAt.toISOString(),
            ticketCount: sorteoGroups.find(g => g.sorteoId === s.id)?._count.id || 0
          })).sort((a, b) => new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime());

          const multipliersFiltered = multipliers
            .filter((m: any) => {
              if (context.role === Role.VENDEDOR && allowedMultiplierIds) {
                return allowedMultiplierIds.has(m.id);
              }
              return true;
            })
            .map((m: any) => ({
              id: m.id,
              name: m.name,
              valueX: m.valueX,
              loteriaId: m.loteriaId,
              loteriaName: m.loteria?.name || '',
              ticketCount: multiplierGroups.find(g => g.multiplierId === m.id)?._count.ticketId || 0
            }))
            .sort((a, b) => a.valueX - b.valueX);

          const vendedores = vendedoresMaster.map(v => ({
            id: v.id,
            name: v.name,
            ventanaId: v.ventanaId,
            ventanaName: v.ventana?.name,
            ticketCount: vendedorGroups.find(g => g.vendedorId === v.id)?._count.id || 0
          })).sort((a, b) => a.name.localeCompare(b.name));

          const ventanas = ventanasMaster.map(v => ({
            id: v.id,
            name: v.name,
            code: v.code,
            ticketCount: ventanaGroups.find(g => g.ventanaId === v.id)?._count.id || 0
          })).sort((a, b) => a.name.localeCompare(b.name));

          return {
            loterias,
            sorteos,
            multipliers: multipliersFiltered,
            vendedores,
            ventanas,
            meta: {
              totalTickets,
            },
          };
        } catch (err: any) {
          logger.error({
            layer: 'service',
            action: 'TICKET_FILTER_OPTIONS_FAIL',
            payload: {
              params,
              error: err.message,
            },
          });

          if (err instanceof AppError) {
            throw err;
          }

          throw new AppError(
            'Error al obtener opciones de filtros',
            500,
            'INTERNAL_ERROR'
          );
        }
      },
      300, // 5 min TTL para filtros
      tags
    );
  },

  /**
   * Obtiene las opciones disponibles para los filtros de numbers-summary
   * basándose en los tickets reales del usuario según su rol
   * GET /api/v1/tickets/numbers-summary/filter-options
   */
  async getNumbersSummaryFilterOptions(params: {
    scope?: string;
    vendedorId?: string;
    ventanaId?: string;
    date?: string;
    fromDate?: string;
    toDate?: string;
    loteriaId?: string;
    sorteoId?: string;
    multiplierId?: string;
    status?: string;
    sorteoStatus?: string;
  }, context: {
    userId: string;
    role: Role;
    ventanaId?: string | null;
    bancaId?: string | null;
  }) {
    const cacheKey = `banca:${context.bancaId || 'all'}:ventana:${context.ventanaId || 'all'}:user:${context.userId}:numbers-summary-filters:${crypto
      .createHash('md5')
      .update(JSON.stringify({ params, context }))
      .digest('hex')}`;

    const tags = ['ticket:numbers-summary-filter-options', `user:${context.userId}`];
    if (context.bancaId) tags.push(`banca:${context.bancaId}`);
    if (params.sorteoId) tags.push(`sorteo:${params.sorteoId}`);

    const inFlight = _filterOptionsInFlight.get(cacheKey);
    if (inFlight) return inFlight;

    const promise = CacheService.wrap(
      cacheKey,
      async () => {
    try {
      // Aplicar RBAC filters para determinar qué tickets puede ver el usuario
      const { applyRbacFilters } = require('../../../utils/rbac');
      const authContext = {
        userId: context.userId,
        role: context.role,
        ventanaId: context.ventanaId,
        bancaId: context.bancaId,
      };

      const effectiveFilters = await applyRbacFilters(authContext, {
        scope: params.scope || 'mine',
        vendedorId: params.vendedorId,
        ventanaId: params.ventanaId,
        loteriaId: params.loteriaId,
        sorteoId: params.sorteoId,
      });

      // Construir filtros de fecha si se proporcionan
      let dateFrom: Date | undefined;
      let dateTo: Date | undefined;

      if (params.date || params.fromDate || params.toDate) {
        const dateRange = resolveDateRange(
          params.date || 'today',
          params.fromDate,
          params.toDate
        );
        dateFrom = dateRange.fromBusinessDate;
        dateTo = dateRange.toBusinessDate;
      }

      // Construir where clause para tickets
      const where: any = {
        deletedAt: null,
        isActive: true,
      };

      if (params.sorteoStatus) {
        where.sorteo = { status: params.sorteoStatus };
      }

      // Aplicar filtros RBAC
      if (effectiveFilters.vendedorId) {
        where.vendedorId = effectiveFilters.vendedorId;
      }
      if (effectiveFilters.ventanaId) {
        where.ventanaId = effectiveFilters.ventanaId;
      }
      if (effectiveFilters.bancaId) {
        where.ventana = { bancaId: effectiveFilters.bancaId };
      }

      // Aplicar filtros de fecha
      if (dateFrom || dateTo) {
        where.businessDate = {};
        if (dateFrom) where.businessDate.gte = dateFrom;
        if (dateTo) where.businessDate.lte = dateTo;
      }

      // Aplicar filtros opcionales (para mostrar solo opciones que cumplen estos filtros)
      if (params.loteriaId) {
        where.loteriaId = params.loteriaId;
      }
      if (params.sorteoId) {
        where.sorteoId = params.sorteoId;
      }
      if (params.status) {
        where.status = params.status;
      }

      // Fase 1: 1 único raw SQL con CTEs — todas las agregaciones en 1 roundtrip/conexión
      // Antes: 5-6 queries Prisma separadas (ConcurrencyManager limit:2 → 3 lotes de 2 conexiones)
      // Ahora: 1 $queryRaw → 1 conexión, sin importar cuántos filtros estén activos

      // Construir JOINs condicionales
      const sqlJoins: Prisma.Sql[] = [];
      if (params.sorteoStatus) {
        sqlJoins.push(Prisma.sql`INNER JOIN "Sorteo" s ON t."sorteoId" = s.id`);
      }
      if (effectiveFilters.bancaId) {
        sqlJoins.push(Prisma.sql`INNER JOIN "Ventana" v ON t."ventanaId" = v.id`);
      }
      const joinsSQL = sqlJoins.length > 0 ? Prisma.join(sqlJoins, ' ') : Prisma.empty;

      // Construir condiciones WHERE
      const sqlConditions: Prisma.Sql[] = [
        Prisma.sql`t."deletedAt" IS NULL`,
        Prisma.sql`t."isActive" = true`,
      ];
      if (params.sorteoStatus) {
        sqlConditions.push(Prisma.sql`s.status::text = ${params.sorteoStatus}`);
      }
      if (effectiveFilters.bancaId) {
        sqlConditions.push(Prisma.sql`v."bancaId" = CAST(${effectiveFilters.bancaId} AS uuid)`);
      }
      if (effectiveFilters.vendedorId) {
        sqlConditions.push(Prisma.sql`t."vendedorId" = CAST(${effectiveFilters.vendedorId} AS uuid)`);
      }
      if (effectiveFilters.ventanaId) {
        sqlConditions.push(Prisma.sql`t."ventanaId" = CAST(${effectiveFilters.ventanaId} AS uuid)`);
      }
      if (dateFrom) {
        sqlConditions.push(Prisma.sql`t."businessDate" >= ${dateFrom}`);
      }
      if (dateTo) {
        sqlConditions.push(Prisma.sql`t."businessDate" <= ${dateTo}`);
      }
      if (params.loteriaId) {
        sqlConditions.push(Prisma.sql`t."loteriaId" = CAST(${params.loteriaId} AS uuid)`);
      }
      if (params.sorteoId) {
        sqlConditions.push(Prisma.sql`t."sorteoId" = CAST(${params.sorteoId} AS uuid)`);
      }
      if (params.status) {
        sqlConditions.push(Prisma.sql`t.status::text = ${params.status}`);
      }
      if (params.multiplierId) {
        sqlConditions.push(Prisma.sql`EXISTS (
          SELECT 1 FROM "Jugada" jf
          WHERE jf."ticketId" = t.id
            AND jf."multiplierId" = CAST(${params.multiplierId} AS uuid)
            AND jf."deletedAt" IS NULL
            AND jf."isActive" = true
            AND jf.type::text = 'NUMERO'
        )`);
      }
      const whereSQL = Prisma.join(sqlConditions, ' AND ');

      // CTEs opcionales según rol
      const multiplierFilter = params.multiplierId
        ? Prisma.sql`AND j."multiplierId" = CAST(${params.multiplierId} AS uuid)`
        : Prisma.empty;
      const vendedorCte = (context.role === Role.ADMIN || context.role === Role.VENTANA)
        ? Prisma.sql`, vendedor_counts AS (SELECT "vendedorId"::text AS id, COUNT(*)::int AS cnt FROM filtered_tickets GROUP BY "vendedorId")`
        : Prisma.empty;
      const ventanaCte = context.role === Role.ADMIN
        ? Prisma.sql`, ventana_counts AS (SELECT "ventanaId"::text AS id, COUNT(*)::int AS cnt FROM filtered_tickets GROUP BY "ventanaId")`
        : Prisma.empty;
      const vendedorSelect = (context.role === Role.ADMIN || context.role === Role.VENTANA)
        ? Prisma.sql`, (SELECT COALESCE(json_agg(json_build_object('id', id, 'cnt', cnt)), '[]'::json) FROM vendedor_counts) AS vendedor_groups`
        : Prisma.sql`, '[]'::json AS vendedor_groups`;
      const ventanaSelect = context.role === Role.ADMIN
        ? Prisma.sql`, (SELECT COALESCE(json_agg(json_build_object('id', id, 'cnt', cnt)), '[]'::json) FROM ventana_counts) AS ventana_groups`
        : Prisma.sql`, '[]'::json AS ventana_groups`;

      type RawAggGroup = { id: string; cnt: number };
      type RawAggResult = {
        total_tickets: bigint;
        loteria_groups: RawAggGroup[] | null;
        sorteo_groups: RawAggGroup[] | null;
        multiplier_groups: RawAggGroup[] | null;
        vendedor_groups: RawAggGroup[] | null;
        ventana_groups: RawAggGroup[] | null;
      };

      const [rawAgg] = await prisma.$queryRaw<RawAggResult[]>`
        WITH filtered_tickets AS (
          SELECT t.id, t."loteriaId", t."sorteoId", t."vendedorId", t."ventanaId"
          FROM "Ticket" t
          ${joinsSQL}
          WHERE ${whereSQL}
        ),
        loteria_counts AS (
          SELECT "loteriaId"::text AS id, COUNT(*)::int AS cnt FROM filtered_tickets GROUP BY "loteriaId"
        ),
        sorteo_counts AS (
          SELECT "sorteoId"::text AS id, COUNT(*)::int AS cnt FROM filtered_tickets GROUP BY "sorteoId"
        ),
        multiplier_counts AS (
          SELECT j."multiplierId"::text AS id, COUNT(DISTINCT j."ticketId")::int AS cnt
          FROM "Jugada" j
          INNER JOIN filtered_tickets ft ON j."ticketId" = ft.id
          WHERE j."deletedAt" IS NULL AND j."isActive" = true
            AND j.type::text = 'NUMERO' AND j."multiplierId" IS NOT NULL
            ${multiplierFilter}
          GROUP BY j."multiplierId"
        )
        ${vendedorCte}
        ${ventanaCte}
        SELECT
          (SELECT COUNT(*) FROM filtered_tickets)::bigint AS total_tickets,
          (SELECT COALESCE(json_agg(json_build_object('id', id, 'cnt', cnt)), '[]'::json) FROM loteria_counts)    AS loteria_groups,
          (SELECT COALESCE(json_agg(json_build_object('id', id, 'cnt', cnt)), '[]'::json) FROM sorteo_counts)     AS sorteo_groups,
          (SELECT COALESCE(json_agg(json_build_object('id', id, 'cnt', cnt)), '[]'::json) FROM multiplier_counts) AS multiplier_groups
          ${vendedorSelect}
          ${ventanaSelect}
      `;

      // Mapear a la misma interfaz que usaban los Prisma groupBy (Fase 2, 3, 4 no cambian)
      const totalTickets = Number(rawAgg.total_tickets);
      const loteriaGroups   = (rawAgg.loteria_groups    || []).map(g => ({ loteriaId:    g.id, _count: { id:       g.cnt } }));
      const sorteoGroups    = (rawAgg.sorteo_groups     || []).map(g => ({ sorteoId:     g.id, _count: { id:       g.cnt } }));
      const multiplierGroups = (rawAgg.multiplier_groups || []).map(g => ({ multiplierId: g.id, _count: { ticketId: g.cnt } }));
      const vendedorGroups  = (rawAgg.vendedor_groups   || []).map(g => ({ vendedorId:   g.id, _count: { id:       g.cnt } }));
      const ventanaGroups   = (rawAgg.ventana_groups    || []).map(g => ({ ventanaId:    g.id, _count: { id:       g.cnt } }));

      // Fase 2: fetch entidades maestras a partir de los IDs agrupados (listas pequeñas, sin riesgo de 32767)
      const masterTasks: (() => Promise<any>)[] = [
        () => prisma.loteria.findMany({
          where: { id: { in: loteriaGroups.map((g: any) => g.loteriaId).filter(Boolean) } },
          select: { id: true, name: true },
        }),
        () => prisma.sorteo.findMany({
          where: { id: { in: sorteoGroups.map((g: any) => g.sorteoId).filter(Boolean) } },
          select: { id: true, name: true, scheduledAt: true, loteriaId: true, loteria: { select: { name: true } } },
        }),
        () => prisma.loteriaMultiplier.findMany({
          where: {
            id: { in: multiplierGroups.map((g: any) => g.multiplierId).filter(Boolean) },
            isActive: true,
          },
          select: { id: true, name: true, valueX: true, loteriaId: true, loteria: { select: { id: true, name: true } } },
        }),
      ];

      if (vendedorGroups.length > 0) {
        masterTasks.push(() => prisma.user.findMany({
          where: { id: { in: vendedorGroups.map((g: any) => g.vendedorId).filter(Boolean) } },
          select: { id: true, name: true, ventanaId: true, ventana: { select: { id: true, name: true } } },
        }));
      }

      if (ventanaGroups.length > 0) {
        masterTasks.push(() => prisma.ventana.findMany({
          where: { id: { in: ventanaGroups.map((g: any) => g.ventanaId).filter(Boolean) } },
          select: { id: true, name: true, code: true },
        }));
      }

      const masterResults = await ConcurrencyManager.runLimited(masterTasks, { limit: 2, label: 'numbers-summary-filter-options-masters' });
      const loteriasMaster = masterResults[0] as any[];
      const sorteosMaster = masterResults[1] as any[];
      const multipliers = masterResults[2] as any[];
      let masterNextIdx = 3;
      const vendedoresMaster = (vendedorGroups.length > 0) ? masterResults[masterNextIdx++] as any[] : [];
      const ventanasMaster = (ventanaGroups.length > 0) ? masterResults[masterNextIdx] as any[] : [];

      // Fase 3: Para vendedores, filtrar multiplicadores según política de comisión
      let allowedMultiplierIds: Set<string> | null = null;
      if (context.role === Role.VENDEDOR && multipliers.length > 0) {
        const loteriasConMultipliers = Array.from(new Set(multipliers.map((m: any) => m.loteriaId).filter(Boolean)));
        allowedMultiplierIds = new Set<string>();

        const allowedTasks: (() => Promise<any>)[] = [];
        loteriasConMultipliers.forEach((loteriaId) => {
          allowedTasks.push(() => UserService.getAllowedMultipliers(context.userId, loteriaId as string, 'NUMERO'));
          allowedTasks.push(() => UserService.getAllowedMultipliers(context.userId, loteriaId as string, 'REVENTADO'));
        });

        const allowedResults = await ConcurrencyManager.runLimited(allowedTasks, { limit: 2, label: 'numbers-summary-filter-options-allowed' });
        allowedResults.forEach((res: any) => {
          res.data.forEach((m: any) => allowedMultiplierIds!.add(m.id));
        });
      }

      // Fase 4: Construir respuesta mapeando los counts de las agrupaciones
      const loterias = loteriasMaster.map((l: any) => ({
        id: l.id,
        name: l.name,
        ticketCount: loteriaGroups.find((g: any) => g.loteriaId === l.id)?._count.id || 0,
      })).sort((a: any, b: any) => a.name.localeCompare(b.name));

      const sorteos = sorteosMaster.map((s: any) => ({
        id: s.id,
        name: s.name,
        loteriaId: s.loteriaId,
        loteriaName: s.loteria?.name || '',
        scheduledAt: s.scheduledAt.toISOString(),
        ticketCount: sorteoGroups.find((g: any) => g.sorteoId === s.id)?._count.id || 0,
      })).sort((a: any, b: any) => new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime());

      const multipliersFiltered = multipliers
        .filter((m: any) => {
          if (context.role === Role.VENDEDOR && allowedMultiplierIds) {
            return allowedMultiplierIds.has(m.id);
          }
          return true;
        })
        .map((m: any) => ({
          id: m.id,
          name: m.name,
          valueX: m.valueX,
          loteriaId: m.loteriaId,
          loteriaName: m.loteria?.name || '',
          ticketCount: multiplierGroups.find((g: any) => g.multiplierId === m.id)?._count.ticketId || 0,
        }))
        .sort((a: any, b: any) => a.valueX - b.valueX);

      const vendedores = vendedoresMaster.map((v: any) => ({
        id: v.id,
        name: v.name,
        ventanaId: v.ventanaId,
        ventanaName: v.ventana?.name,
        ticketCount: vendedorGroups.find((g: any) => g.vendedorId === v.id)?._count.id || 0,
      })).sort((a: any, b: any) => a.name.localeCompare(b.name));

      const ventanas = ventanasMaster.map((v: any) => ({
        id: v.id,
        name: v.name,
        code: v.code,
        ticketCount: ventanaGroups.find((g: any) => g.ventanaId === v.id)?._count.id || 0,
      })).sort((a: any, b: any) => a.name.localeCompare(b.name));

      return {
        loterias,
        sorteos,
        multipliers: multipliersFiltered,
        vendedores,
        ventanas,
        meta: {
          totalTickets,
        },
      };
    } catch (err: any) {
      logger.error({
        layer: 'service',
        action: 'TICKET_NUMBERS_SUMMARY_FILTER_OPTIONS_FAIL',
        payload: {
          params,
          error: err.message,
        },
      });

      if (err instanceof AppError) {
        throw err;
      }

      throw new AppError(
        'Error al obtener opciones de filtros para numbers-summary',
        500,
        'INTERNAL_ERROR'
      );
    }
      },
      300, // TTL 300s: el cache tiene invalidación por tags (banca/sorteo/user), 5min es seguro
      tags
    );

    _filterOptionsInFlight.set(cacheKey, promise);
    promise.finally(() => _filterOptionsInFlight.delete(cacheKey));
    return promise;
  },

  /**
   * Obtiene la imagen del ticket como blob PNG
   * GET /api/v1/tickets/:id/image
   */
  async getTicketImage(id: string, userId: string, role: Role, requestId?: string): Promise<Buffer> {
    try {
      // Obtener ticket con todas las relaciones necesarias
      const ticket = await prisma.ticket.findUnique({
        where: { id },
        select: {
          id: true,
          ticketNumber: true,
          totalAmount: true,
          clienteNombre: true,
          createdAt: true,
          isActive: true, // Add isActive
          vendedorId: true,
          ventanaId: true,
          jugadas: {
            where: { deletedAt: null },
            select: {
              type: true,
              number: true,
              amount: true,
              finalMultiplierX: true,
            },
            orderBy: { createdAt: 'asc' },
          },
          sorteo: {
            select: {
              name: true,
              scheduledAt: true,
              loteria: {
                select: {
                  name: true,
                  rulesJson: true,
                },
              },
            },
          },
          vendedor: {
            select: {
              name: true,
              phone: true,
              code: true,
              settings: true,
            },
          },
          ventana: {
            select: {
              name: true,
              phone: true,
              settings: true,
            },
          },
        },
      });

      if (!ticket) {
        throw new AppError("Ticket no encontrado", 404);
      }

      // Verificar permisos (RBAC)
      if (role === Role.VENDEDOR && ticket.vendedorId !== userId) {
        throw new AppError("No autorizado para ver este ticket", 403);
      } else if (role === Role.VENTANA) {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { ventanaId: true },
        });
        if (!user?.ventanaId || ticket.ventanaId !== user.ventanaId) {
          throw new AppError("No autorizado para ver este ticket", 403);
        }
      }
      // ADMIN puede ver cualquier ticket

      // Obtener configuraciones de impresión
      // IMPORTANTE: Siempre leer y validar la configuración del vendedor para el código de barras
      const vendedorConfig = extractPrintConfig(
        ticket.vendedor?.settings,
        ticket.vendedor?.name || null,
        ticket.vendedor?.phone || null
      );
      const ventanaConfig = extractPrintConfig(
        ticket.ventana?.settings,
        ticket.ventana?.name || null,
        ticket.ventana?.phone || null
      );

      // Validar explícitamente la configuración del código de barras del vendedor
      // Si printBarcode es false, no se mostrará el código de barras en la imagen
      const vendedorBarcodeEnabled = vendedorConfig.printBarcode !== false;
      const ventanaBarcodeEnabled = ventanaConfig.printBarcode !== false;

      // Formatear sorteo.name concatenando la hora
      const sorteoWithFormattedName = {
        ...ticket.sorteo,
        name: formatSorteoNameWithTime(ticket.sorteo.name, ticket.sorteo.scheduledAt),
      };

      // Determinar ancho según configuración de impresión (prioridad: vendedor > ventana > default)
      // printWidth viene en mm (58 o 88), convertir a píxeles
      const { mmToPixels } = await import('../../../services/ticket-image-generator.service');
      const printWidthMm = vendedorConfig.printWidth || ventanaConfig.printWidth || 58; // Default: 58mm
      const printWidthPx = mmToPixels(printWidthMm);

      // Generar imagen
      const { generateTicketImage } = await import('../../../services/ticket-image-generator.service');

      const imageBuffer = await generateTicketImage(
        {
          ticket: {
            id: ticket.id,
            ticketNumber: ticket.ticketNumber,
            totalAmount: ticket.totalAmount,
            clienteNombre: ticket.clienteNombre,
            createdAt: ticket.createdAt,
            isActive: ticket.isActive, // Pass isActive
            jugadas: ticket.jugadas,
            sorteo: {
              ...sorteoWithFormattedName,
              loteria: ticket.sorteo.loteria,
            },
            vendedor: {
              name: ticket.vendedor?.name || null,
              code: ticket.vendedor?.code || null,
              printName: vendedorConfig.printName,
              printPhone: vendedorConfig.printPhone,
              // Siempre validar la configuración del vendedor: si printBarcode es false, no mostrar código de barras
              printBarcode: vendedorBarcodeEnabled,
              printFooter: vendedorConfig.printFooter,
            },
            ventana: {
              name: ticket.ventana?.name || null,
              printName: ventanaConfig.printName,
              printPhone: ventanaConfig.printPhone,
              // Validar también la configuración de la ventana
              printBarcode: ventanaBarcodeEnabled,
              printFooter: ventanaConfig.printFooter,
            },
          },
        },
        {
          width: printWidthPx,
          scale: 2, // Calidad suficiente para impresión térmica
        }
      );

      logger.info({
        layer: 'service',
        action: 'TICKET_IMAGE_GENERATED',
        userId,
        requestId,
        payload: {
          ticketId: ticket.id,
          imageSize: imageBuffer.length,
          printWidthMm,
          printWidthPx,
        },
      });

      return imageBuffer;
    } catch (err: any) {
      logger.error({
        layer: 'service',
        action: 'TICKET_IMAGE_GENERATION_FAILED',
        userId,
        requestId,
        payload: {
          ticketId: id,
          error: err.message,
        },
      });
      throw err;
    }
  },
};

export default TicketService;
