import { ActivityType, Role } from "@prisma/client";
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
import { resolveDateRange } from "../../../utils/dateRange";
import { UserService } from "./user.service";
import { nowCR, validateDate, formatDateCRWithTZ } from "../../../utils/datetime";
import { getCRLocalComponents } from "../../../utils/businessDate";
import { PDFDocument } from "pdf-lib";

const CUTOFF_GRACE_MS = 1000;
// Updated: Added clienteNombre field support

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
      const actor = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true, ventanaId: true, isActive: true },
      });
      if (!actor) throw new AppError("Authenticated user not found", 401);

      // Resolver vendedor efectivo (impersonación opcional para ADMIN/VENTANA)
      const requestedVendedorId: string | undefined = data?.vendedorId;
      let effectiveVendedorId: string;
      let ventanaId: string;

      if (requestedVendedorId) {
        if (actor.role !== Role.ADMIN && actor.role !== Role.VENTANA) {
          throw new AppError("vendedorId no permitido para este rol", 403);
        }
        const target = await prisma.user.findUnique({
          where: { id: requestedVendedorId },
          select: { id: true, role: true, ventanaId: true, isActive: true },
        });
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
      const ventana = await prisma.ventana.findUnique({
        where: { id: ventanaId },
        select: { id: true, bancaId: true, isActive: true },
      });
      if (!ventana || !ventana.isActive) throw new AppError("La Ventana no existe o está inactiva", 404);

      // Sorteo válido + obtener lotería desde sorteo
      const sorteo = await prisma.sorteo.findUnique({
        where: { id: sorteoId },
        select: {
          id: true,
          name: true, //  Incluir name para formatear con hora
          scheduledAt: true,
          status: true,
          loteriaId: true,
          loteria: { select: { id: true, name: true, rulesJson: true } },
        },
      });
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
      const [user, ventanaWithBanca, listeroUser] = await Promise.all([
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
      ]);

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

      //  Crear ticket con método optimizado
      const { ticket, warnings } = await TicketRepository.createOptimized(
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
        }
      );

      // ️ Obtener configuraciones de impresión del vendedor y ventana
      const vendedor = await prisma.user.findUnique({
        where: { id: effectiveVendedorId },
        select: { name: true, phone: true, settings: true },
      });
      const ventanaData = await prisma.ventana.findUnique({
        where: { id: ventanaId },
        select: { name: true, phone: true, settings: true },
      });

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
      const jugadasCount = (ticket as any).jugadas?.length ?? jugadasIn.length;

      await ActivityService.log({
        userId,
        action: ActivityType.TICKET_CREATE,
        targetType: "TICKET",
        targetId: ticket.id,
        details: {
          ticketNumber: ticket.ticketNumber,
          totalAmount: ticket.totalAmount,
          jugadas: jugadasCount,
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
    const vendedor = await prisma.user.findUnique({
      where: { id: ticket.vendedorId },
      select: { name: true, phone: true, settings: true },
    });
    const ventanaData = await prisma.ventana.findUnique({
      where: { id: ticket.ventanaId },
      select: { name: true, phone: true, settings: true },
    });

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
    const ticket = await TicketRepository.cancel(id, userId);

    await ActivityService.log({
      userId,
      action: ActivityType.TICKET_CANCEL,
      targetType: "TICKET",
      targetId: id,
      details: { reason: "Cancelled by user" },
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
      details: { restored: true },
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
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        include: { jugadas: true, vendedor: true, ventana: true, sorteo: { select: { id: true, status: true } } },
      });

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
        const existing = await prisma.ticketPayment.findUnique({
          where: { idempotencyKey: data.idempotencyKey },
          include: { ticket: true },
        });
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
      const user = await prisma.user.findUnique({ where: { id: userId } });
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
      const updated = await prisma.$transaction(async (tx) => {
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
        return await tx.ticket.update({
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
      });

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
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        include: { jugadas: true },
      });

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

      let dateRange: { fromAt: Date; toAt: Date } | null = null;

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
          createdAt: {
            gte: dateRange.fromAt,
            lte: dateRange.toAt,
          },
        } : {}),
        // Excluir tickets CANCELLED por defecto
        // Si se especifica params.status, usar ese valor; si no, excluir CANCELLED
        status: params.status
          ? params.status
          : { notIn: ["CANCELLED", "EXCLUDED"] }, // Excluir CANCELLED si no se especifica
        isActive: true,
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
        const multiplier = await prisma.loteriaMultiplier.findUnique({
          where: { id: params.multiplierId },
          select: { name: true },
        });
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
        const sorteo = await prisma.sorteo.findUnique({
          where: { id: params.sorteoId },
          select: {
            id: true,
            name: true,
            status: true,
            winningNumber: true, //  NUEVO: Obtener número ganador
            loteria: {
              select: { rulesJson: true }
            }
          },
        });
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

      const tickets = await prisma.ticket.findMany({
        where: ticketWhere,
        select: {
          id: true,
          // Include jugadas directly
          jugadas: {
            where: jugadaFilter,
            select: {
              id: true,
              ticketId: true,
              number: true,
              reventadoNumber: true,
              type: true,
              amount: true,
              multiplierId: true, //  CRÍTICO: Necesario para filtrar por multiplierId
              commissionAmount: true,
              listeroCommissionAmount: true,
            },
          },
          // Include metadata to avoid separate queries
          ...(params.ventanaId ? {
            ventana: {
              select: { name: true },
            },
          } : {}),
          ...(params.vendedorId ? {
            vendedor: {
              select: { name: true, code: true },
            },
          } : {}),
          ...(params.loteriaId ? {
            loteria: {
              select: { name: true },
            },
          } : {}),
          ...(params.sorteoId ? {
            sorteo: {
              select: { scheduledAt: true },
            },
          } : {}),
        },
      });

      // Si no hay tickets, retornar respuesta vacía
      if (tickets.length === 0) {
        logger.warn({
          layer: "service",
          action: "TICKET_NUMBERS_SUMMARY_NO_TICKETS",
          payload: { params, message: "No tickets found for the given filters" },
        });
        // Continuar con lógica normal - retornará ceros
      }

      // Flatten jugadas from all tickets
      let jugadas = tickets.flatMap(t => t.jugadas);

      //  CRÍTICO: Si hay filtro por multiplierId, filtrar jugadas en memoria
      // Los tickets ya están filtrados (solo tickets con al menos una jugada con ese multiplierId)
      // PERO necesitamos filtrar las jugadas para incluir solo:
      // - Jugadas NUMERO con ese multiplierId
      // - Jugadas REVENTADO asociadas a esos números base
      if (params.multiplierId) {
        // Primero, obtener números base de jugadas NUMERO con ese multiplierId
        const numerosBaseIncluidos = new Set<string>();
        jugadas.forEach((jugada) => {
          if (jugada.type === 'NUMERO' && jugada.multiplierId === params.multiplierId) {
            numerosBaseIncluidos.add(jugada.number);
          }
        });

        // Filtrar: incluir solo NUMERO con ese multiplierId O REVENTADO del mismo número base
        jugadas = jugadas.filter((jugada) => {
          if (jugada.type === 'NUMERO') {
            return jugada.multiplierId === params.multiplierId;
          } else if (jugada.type === 'REVENTADO') {
            // Incluir REVENTADO solo si su número base está en el filtro
            return numerosBaseIncluidos.has(jugada.number);
          }
          return false;
        });

        logger.info({
          layer: "service",
          action: "TICKET_NUMBERS_SUMMARY_MULTIPLIER_FILTER",
          payload: {
            multiplierId: params.multiplierId,
            totalJugadasBeforeFilter: tickets.flatMap(t => t.jugadas).length,
            totalJugadasAfterFilter: jugadas.length,
            numerosBaseIncluidos: numerosBaseIncluidos.size,
          },
        });
      }

      // Extract metadata from first ticket (all tickets share same filters)
      const ventanaName = tickets[0]?.ventana?.name;
      const vendedorName = tickets[0]?.vendedor?.name;
      const vendedorCode = tickets[0]?.vendedor?.code;
      const loteriaName = tickets[0]?.loteria?.name;
      const sorteoDate = tickets[0]?.sorteo?.scheduledAt;

      // Agrupar por número base
      //  CRÍTICO: Para NUMERO: usar jugada.number
      //  CRÍTICO: Para REVENTADO: usar jugada.number (número base) - los reventados se agrupan con su número base
      const numbersMap = new Map<string, {
        amountByNumber: number;
        amountByReventado: number;
        ticketIdsByNumber: Set<string>;
        ticketIdsByReventado: Set<string>;
      }>();

      //  Inicialización dinámica: solo crear entradas para números con ventas (lazy)
      // No inicializamos aquí - se crearán bajo demanda en el loop de jugadas

      // Procesar jugadas
      //  CRÍTICO: Los REVENTADOS deben agruparse por el número base (jugada.number), no por reventadoNumber
      // Un REVENTADO siempre está asociado a un número base (NUMERO) del mismo ticket
      for (const jugada of jugadas) {
        let numberToUse: string;

        if (jugada.type === 'NUMERO') {
          // Para NUMERO, usar el número directamente
          numberToUse = jugada.number.padStart(sorteoDigits, '0');
        } else if (jugada.type === 'REVENTADO') {
          //  CRÍTICO: Para REVENTADO, usar jugada.number (número base) como clave
          // El reventadoNumber es solo informativo, pero la agrupación debe ser por el número base
          numberToUse = jugada.number.padStart(sorteoDigits, '0');
        } else {
          // Por defecto, tratar como NUMERO (compatibilidad con datos antiguos)
          numberToUse = jugada.number.padStart(sorteoDigits, '0');
        }

        //  Validar que el número esté en el rango dinámico (0 a maxNumber)
        const numValue = parseInt(numberToUse, 10);
        if (numValue < 0 || numValue > maxNumber) {
          continue; // Saltar números inválidos
        }

        let numData = numbersMap.get(numberToUse);
        if (!numData) {
          // Si por alguna razón no existe, crear entrada
          numData = {
            amountByNumber: 0,
            amountByReventado: 0,
            ticketIdsByNumber: new Set(),
            ticketIdsByReventado: new Set(),
          };
          numbersMap.set(numberToUse, numData);
        }

        if (jugada.type === 'NUMERO') {
          numData.amountByNumber += jugada.amount || 0;
          numData.ticketIdsByNumber.add(jugada.ticketId);
        } else if (jugada.type === 'REVENTADO') {
          //  CRÍTICO: Los REVENTADOS se agregan al número base
          numData.amountByReventado += jugada.amount || 0;
          numData.ticketIdsByReventado.add(jugada.ticketId);
        } else {
          // Por defecto, tratar como NUMERO
          numData.amountByNumber += jugada.amount || 0;
          numData.ticketIdsByNumber.add(jugada.ticketId);
        }
      }

      //  Determinar rango de números a retornar (paginación)
      const pageSize = params.pageSize || 100;
      const page = params.page;

      let startNumber = 0;
      let endNumber = maxNumber;

      if (page !== undefined) {
        // Si se especifica página, calcular rango
        startNumber = page * pageSize;
        endNumber = Math.min(startNumber + pageSize - 1, maxNumber);
      }

      //  Construir array de respuesta ordenado dinámicamente
      const data = Array.from({ length: endNumber - startNumber + 1 }, (_, i) => {
        const numValue = startNumber + i;
        const numStr = String(numValue).padStart(sorteoDigits, '0');
        const numData = numbersMap.get(numStr) || {
          amountByNumber: 0,
          amountByReventado: 0,
          ticketIdsByNumber: new Set<string>(),
          ticketIdsByReventado: new Set<string>(),
        };

        // Calcular ticketCount: tickets únicos que tienen apuestas en este número
        const allTicketIds = new Set([
          ...Array.from(numData.ticketIdsByNumber),
          ...Array.from(numData.ticketIdsByReventado),
        ]);

        return {
          number: numStr,
          amountByNumber: numData.amountByNumber,
          amountByReventado: numData.amountByReventado,
          totalAmount: numData.amountByNumber + numData.amountByReventado,
          ticketCount: allTicketIds.size,
          ticketsByNumber: numData.ticketIdsByNumber.size,
          ticketsByReventado: numData.ticketIdsByReventado.size,
        };
      });

      //  Calcular totales GLOBALES (de todos los números, no solo la página actual)
      let totalAmountByNumber = 0;
      let totalAmountByReventado = 0;
      const allUniqueTicketIds = new Set<string>();

      for (const numData of numbersMap.values()) {
        totalAmountByNumber += numData.amountByNumber;
        totalAmountByReventado += numData.amountByReventado;
        numData.ticketIdsByNumber.forEach(id => allUniqueTicketIds.add(id));
        numData.ticketIdsByReventado.forEach(id => allUniqueTicketIds.add(id));
      }

      const totalAmount = totalAmountByNumber + totalAmountByReventado;
      const totalTickets = allUniqueTicketIds.size;

      //  NUEVO: Calcular commission breakdown por tipo de jugada
      let commissionByNumber = 0;
      let commissionByReventado = 0;

      for (const jugada of jugadas) {
        // Determinar qué comisión usar según dimension
        // Si dimension='vendedor' o vendedorId presente: usar commissionAmount (vendedor)
        // Si dimension='listero' o ventanaId presente: usar listeroCommissionAmount (listero)
        let commissionToUse = 0;

        if (params.dimension === 'vendedor' || (params.vendedorId && !params.dimension)) {
          commissionToUse = jugada.commissionAmount || 0;
        } else if (params.dimension === 'listero' || params.ventanaId) {
          commissionToUse = jugada.listeroCommissionAmount || 0;
        } else {
          // Default: usar listeroCommissionAmount
          commissionToUse = jugada.listeroCommissionAmount || 0;
        }

        // Acumular por tipo
        if (jugada.type === 'NUMERO') {
          commissionByNumber += commissionToUse;
        } else if (jugada.type === 'REVENTADO') {
          commissionByReventado += commissionToUse;
        }
      }

      const totalCommission = commissionByNumber + commissionByReventado;

      //  NUEVO: Obtener solo los números que tienen apuestas (amountByNumber > 0 o amountByReventado > 0)
      const numbersWithBets = Array.from(numbersMap.entries())
        .filter(([_, numData]) => numData.amountByNumber > 0 || numData.amountByReventado > 0)
        .map(([number, _]) => number)
        .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

      return {
        data,
        meta: {
          dateFilter: params.date || "today",
          ...(params.fromDate ? { fromDate: params.fromDate } : {}),
          ...(params.toDate ? { toDate: params.toDate } : {}),
          //  NUEVO: Metadatos dinámicos basados en sorteo.digits
          totalNumbers: maxNumber + 1,
          sorteoDigits,
          maxNumber,
          reventadoEnabled, //  NUEVO: Indica si reventado está habilitado (para mostrar/ocultar columnas en FE)
          ...(sorteoName ? { sorteoName } : {}),
          ...(multiplierName ? { multiplierName } : {}),
          //  NUEVO: Metadatos de paginación
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
          totalAmount,
          totalTickets,
          //  NUEVO: Commission breakdown
          commissionByNumber,
          commissionByReventado,
          totalCommission,
          //  NUEVO: Números que tienen apuestas
          numbersWithBets,
          //  NUEVO: Información de números ganadores (si el sorteo está evaluado)
          ...(winningNumbersInfo ? { winningNumbers: winningNumbersInfo } : {}),
          ...(params.dimension ? { dimension: params.dimension } : {}),
          ...(params.ventanaId ? { ventanaId: params.ventanaId } : {}),
          ...(params.vendedorId ? { vendedorId: params.vendedorId } : {}),
          ...(ventanaName ? { ventanaName } : {}),
          ...(vendedorName ? { vendedorName } : {}),
          ...(vendedorCode ? { vendedorCode } : {}),
          ...(loteriaName ? { loteriaName } : {}),
          ...(sorteoDate ? { sorteoDate } : {}),
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

      for (const multiplier of multipliers) {
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

        pngPages
          .filter(p => p && p.content)
          .forEach((p, idx) => {
            const buffer = p.content as Buffer;
            if (!buffer) {
              return;
            }
            pages.push({
              page: idx,
              filename: `lista-${multiplier.name || multiplier.valueX || 'mult'}-${idx + 1}.png`,
              image: buffer.toString('base64'),
              multiplierId: multiplier.id,
              multiplierName: multiplier.name,
              multiplierValue: multiplier.valueX,
            });
          });
      }

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
  }, context: {
    userId: string;
    role: Role;
    ventanaId?: string | null;
    bancaId?: string | null;
  }) {
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
      let dateFrom: Date | undefined;
      let dateTo: Date | undefined;

      if (params.date || params.fromDate || params.toDate) {
        const dateRange = resolveDateRange(
          params.date || 'today',
          params.fromDate,
          params.toDate
        );
        dateFrom = dateRange.fromAt;
        dateTo = dateRange.toAt;
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

      // Aplicar filtros de fecha
      if (dateFrom || dateTo) {
        where.createdAt = {};
        if (dateFrom) where.createdAt.gte = dateFrom;
        if (dateTo) where.createdAt.lt = dateTo;
      }

      // Aplicar filtro de estado
      if (params.status) {
        where.status = params.status;
      }

      // Obtener tickets con relaciones necesarias
      const tickets = await prisma.ticket.findMany({
        where,
        select: {
          id: true,
          loteriaId: true,
          sorteoId: true,
          vendedorId: true,
          jugadas: {
            where: {
              deletedAt: null,
              isActive: true,
            },
            select: {
              multiplierId: true,
            },
          },
          loteria: {
            select: {
              id: true,
              name: true,
            },
          },
          sorteo: {
            select: {
              id: true,
              name: true,
              scheduledAt: true,
              loteriaId: true,
            },
          },
          vendedor: {
            select: {
              id: true,
              name: true,
              ventanaId: true,
              ventana: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
      });

      const totalTickets = tickets.length;

      // Agrupar por lotería
      const loteriaMap = new Map<string, { id: string; name: string; count: number }>();
      tickets.forEach((ticket) => {
        if (ticket.loteria) {
          const existing = loteriaMap.get(ticket.loteria.id);
          if (existing) {
            existing.count++;
          } else {
            loteriaMap.set(ticket.loteria.id, {
              id: ticket.loteria.id,
              name: ticket.loteria.name,
              count: 1,
            });
          }
        }
      });

      // Agrupar por sorteo
      const sorteoMap = new Map<string, {
        id: string;
        name: string;
        loteriaId: string;
        loteriaName: string;
        scheduledAt: Date;
        count: number;
      }>();
      tickets.forEach((ticket) => {
        if (ticket.sorteo) {
          const existing = sorteoMap.get(ticket.sorteo.id);
          if (existing) {
            existing.count++;
          } else {
            sorteoMap.set(ticket.sorteo.id, {
              id: ticket.sorteo.id,
              name: ticket.sorteo.name,
              loteriaId: ticket.sorteo.loteriaId,
              loteriaName: ticket.loteria?.name || '',
              scheduledAt: ticket.sorteo.scheduledAt,
              count: 1,
            });
          }
        }
      });

      // Agrupar por multiplicador (de jugadas)
      // IMPORTANTE: Contar TICKETS únicos, no jugadas
      const multiplierMap = new Map<string, {
        id: string;
        ticketIds: Set<string>; // Set de ticket IDs únicos
        loteriaIds: Set<string>;
      }>();
      tickets.forEach((ticket) => {
        // Obtener multiplicadores únicos de este ticket
        const ticketMultiplierIds = new Set<string>();
        ticket.jugadas.forEach((jugada) => {
          if (jugada.multiplierId) {
            ticketMultiplierIds.add(jugada.multiplierId);
          }
        });

        // Para cada multiplicador único en este ticket, agregar el ticket ID
        ticketMultiplierIds.forEach((multiplierId) => {
          const existing = multiplierMap.get(multiplierId);
          if (existing) {
            existing.ticketIds.add(ticket.id);
            if (ticket.loteriaId) {
              existing.loteriaIds.add(ticket.loteriaId);
            }
          } else {
            multiplierMap.set(multiplierId, {
              id: multiplierId,
              ticketIds: new Set([ticket.id]),
              loteriaIds: new Set(ticket.loteriaId ? [ticket.loteriaId] : []),
            });
          }
        });
      });

      // Obtener información de multiplicadores
      const multiplierIds = Array.from(multiplierMap.keys());
      const multipliers = multiplierIds.length > 0
        ? await prisma.loteriaMultiplier.findMany({
          where: {
            id: { in: multiplierIds },
            isActive: true,
          },
          select: {
            id: true,
            name: true,
            valueX: true,
            loteriaId: true,
            loteria: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        })
        : [];

      // Para vendedores, filtrar multiplicadores según política de comisión
      let allowedMultiplierIds: Set<string> | null = null;
      if (context.role === Role.VENDEDOR) {
        // Obtener multiplicadores permitidos para el vendedor
        const loteriasConMultipliers = new Set<string>();
        multipliers.forEach((m) => {
          if (m.loteriaId) {
            loteriasConMultipliers.add(m.loteriaId);
          }
        });

        // Para cada lotería, obtener multiplicadores permitidos
        allowedMultiplierIds = new Set<string>();
        for (const loteriaId of loteriasConMultipliers) {
          try {
            const allowedResult = await UserService.getAllowedMultipliers(
              context.userId,
              loteriaId,
              'NUMERO'
            );
            allowedResult.data.forEach((m) => {
              allowedMultiplierIds!.add(m.id);
            });

            // También obtener para REVENTADO
            const allowedReventadoResult = await UserService.getAllowedMultipliers(
              context.userId,
              loteriaId,
              'REVENTADO'
            );
            allowedReventadoResult.data.forEach((m) => {
              allowedMultiplierIds!.add(m.id);
            });
          } catch (err) {
            // Si hay error (ej: usuario no encontrado), continuar
            logger.warn({
              layer: 'service',
              action: 'FILTER_OPTIONS_ALLOWED_MULTIPLIERS_ERROR',
              payload: {
                userId: context.userId,
                loteriaId,
                error: (err as Error).message,
              },
            });
          }
        }
      }

      // Agrupar por vendedor (solo para ADMIN y VENTANA)
      const vendedorMap = new Map<string, {
        id: string;
        name: string;
        ventanaId?: string;
        ventanaName?: string;
        count: number;
      }>();
      if (context.role === Role.ADMIN || context.role === Role.VENTANA) {
        tickets.forEach((ticket) => {
          if (ticket.vendedor) {
            const existing = vendedorMap.get(ticket.vendedor.id);
            if (existing) {
              existing.count++;
            } else {
              vendedorMap.set(ticket.vendedor.id, {
                id: ticket.vendedor.id,
                name: ticket.vendedor.name,
                ventanaId: ticket.vendedor.ventanaId || undefined,
                ventanaName: ticket.vendedor.ventana?.name,
                count: 1,
              });
            }
          }
        });
      }

      // Construir respuesta
      const loterias = Array.from(loteriaMap.values())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((l) => ({
          id: l.id,
          name: l.name,
          ticketCount: l.count,
        }));

      const sorteos = Array.from(sorteoMap.values())
        .sort((a, b) => b.scheduledAt.getTime() - a.scheduledAt.getTime())
        .map((s) => ({
          id: s.id,
          name: s.name,
          loteriaId: s.loteriaId,
          loteriaName: s.loteriaName,
          scheduledAt: s.scheduledAt.toISOString(),
          ticketCount: s.count,
        }));

      // Filtrar multiplicadores según política de comisión para vendedores
      const multipliersFiltered = multipliers
        .filter((m) => {
          // Para vendedores, solo incluir multiplicadores permitidos
          if (context.role === Role.VENDEDOR && allowedMultiplierIds) {
            return allowedMultiplierIds.has(m.id);
          }
          // Para otros roles, incluir todos los multiplicadores que tienen tickets
          return multiplierMap.has(m.id);
        })
        .map((m) => {
          const multiplierData = multiplierMap.get(m.id);
          // ticketCount es el número de tickets únicos que tienen este multiplicador
          const ticketCount = multiplierData?.ticketIds.size || 0;
          return {
            id: m.id,
            name: m.name,
            valueX: m.valueX,
            loteriaId: m.loteriaId,
            loteriaName: m.loteria?.name || '',
            ticketCount, //  Ahora cuenta tickets únicos, no jugadas
          };
        })
        .sort((a, b) => a.valueX - b.valueX);

      const vendedores = Array.from(vendedorMap.values())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((v) => ({
          id: v.id,
          name: v.name,
          ventanaId: v.ventanaId,
          ventanaName: v.ventanaName,
          ticketCount: v.count,
        }));

      return {
        loterias,
        sorteos,
        multipliers: multipliersFiltered,
        vendedores,
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
  }, context: {
    userId: string;
    role: Role;
    ventanaId?: string | null;
    bancaId?: string | null;
  }) {
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
        dateFrom = dateRange.fromAt;
        dateTo = dateRange.toAt;
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

      // Aplicar filtros de fecha
      if (dateFrom || dateTo) {
        where.createdAt = {};
        if (dateFrom) where.createdAt.gte = dateFrom;
        if (dateTo) where.createdAt.lt = dateTo;
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

      // Si hay filtro por multiplicador, filtrar jugadas
      const jugadaWhere: any = {
        deletedAt: null,
        isActive: true,
      };
      if (params.multiplierId) {
        jugadaWhere.multiplierId = params.multiplierId;
        jugadaWhere.type = 'NUMERO'; // Solo jugadas NUMERO tienen multiplicador
      }

      // Obtener tickets con relaciones necesarias
      const tickets = await prisma.ticket.findMany({
        where,
        select: {
          id: true,
          loteriaId: true,
          sorteoId: true,
          vendedorId: true,
          ventanaId: true, //  Necesario para agrupar por ventana
          status: true,
          jugadas: {
            where: jugadaWhere,
            select: {
              multiplierId: true,
            },
          },
          loteria: {
            select: {
              id: true,
              name: true,
            },
          },
          sorteo: {
            select: {
              id: true,
              name: true,
              scheduledAt: true,
              loteriaId: true,
            },
          },
          ventana: {
            select: {
              id: true,
              name: true,
              code: true,
            },
          },
          vendedor: {
            select: {
              id: true,
              name: true,
              ventanaId: true,
              ventana: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
      });

      const totalTickets = tickets.length;

      // Agrupar por lotería
      const loteriaMap = new Map<string, { id: string; name: string; count: number }>();
      tickets.forEach((ticket) => {
        if (ticket.loteria) {
          const existing = loteriaMap.get(ticket.loteria.id);
          if (existing) {
            existing.count++;
          } else {
            loteriaMap.set(ticket.loteria.id, {
              id: ticket.loteria.id,
              name: ticket.loteria.name,
              count: 1,
            });
          }
        }
      });

      // Agrupar por sorteo
      const sorteoMap = new Map<string, {
        id: string;
        name: string;
        loteriaId: string;
        loteriaName: string;
        scheduledAt: Date;
        count: number;
      }>();
      tickets.forEach((ticket) => {
        if (ticket.sorteo) {
          const existing = sorteoMap.get(ticket.sorteo.id);
          if (existing) {
            existing.count++;
          } else {
            sorteoMap.set(ticket.sorteo.id, {
              id: ticket.sorteo.id,
              name: ticket.sorteo.name,
              loteriaId: ticket.sorteo.loteriaId,
              loteriaName: ticket.loteria?.name || '',
              scheduledAt: ticket.sorteo.scheduledAt,
              count: 1,
            });
          }
        }
      });

      // Agrupar por multiplicador (de jugadas NUMERO)
      // IMPORTANTE: Contar TICKETS únicos, no jugadas
      const multiplierMap = new Map<string, {
        id: string;
        ticketIds: Set<string>; // Set de ticket IDs únicos
        loteriaIds: Set<string>;
      }>();
      tickets.forEach((ticket) => {
        // Obtener multiplicadores únicos de este ticket
        const ticketMultiplierIds = new Set<string>();
        ticket.jugadas.forEach((jugada) => {
          if (jugada.multiplierId) {
            ticketMultiplierIds.add(jugada.multiplierId);
          }
        });

        // Para cada multiplicador único en este ticket, agregar el ticket ID
        ticketMultiplierIds.forEach((multiplierId) => {
          const existing = multiplierMap.get(multiplierId);
          if (existing) {
            existing.ticketIds.add(ticket.id);
            if (ticket.loteriaId) {
              existing.loteriaIds.add(ticket.loteriaId);
            }
          } else {
            multiplierMap.set(multiplierId, {
              id: multiplierId,
              ticketIds: new Set([ticket.id]),
              loteriaIds: new Set(ticket.loteriaId ? [ticket.loteriaId] : []),
            });
          }
        });
      });

      // Obtener información de multiplicadores
      const multiplierIds = Array.from(multiplierMap.keys());
      const multipliers = multiplierIds.length > 0
        ? await prisma.loteriaMultiplier.findMany({
          where: {
            id: { in: multiplierIds },
            isActive: true,
          },
          select: {
            id: true,
            name: true,
            valueX: true,
            loteriaId: true,
            loteria: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        })
        : [];

      // Para vendedores, filtrar multiplicadores según política de comisión
      let allowedMultiplierIds: Set<string> | null = null;
      if (context.role === Role.VENDEDOR) {
        // Obtener multiplicadores permitidos para el vendedor
        const loteriasConMultipliers = new Set<string>();
        multipliers.forEach((m) => {
          if (m.loteriaId) {
            loteriasConMultipliers.add(m.loteriaId);
          }
        });

        // Para cada lotería, obtener multiplicadores permitidos
        allowedMultiplierIds = new Set<string>();
        for (const loteriaId of loteriasConMultipliers) {
          try {
            const allowedResult = await UserService.getAllowedMultipliers(
              context.userId,
              loteriaId,
              'NUMERO'
            );
            allowedResult.data.forEach((m) => {
              allowedMultiplierIds!.add(m.id);
            });

            // También obtener para REVENTADO
            const allowedReventadoResult = await UserService.getAllowedMultipliers(
              context.userId,
              loteriaId,
              'REVENTADO'
            );
            allowedReventadoResult.data.forEach((m) => {
              allowedMultiplierIds!.add(m.id);
            });
          } catch (err) {
            // Si hay error (ej: usuario no encontrado), continuar
            logger.warn({
              layer: 'service',
              action: 'NUMBERS_SUMMARY_FILTER_OPTIONS_ALLOWED_MULTIPLIERS_ERROR',
              payload: {
                userId: context.userId,
                loteriaId,
                error: (err as Error).message,
              },
            });
          }
        }
      }

      // Agrupar por vendedor (solo para ADMIN y VENTANA)
      const vendedorMap = new Map<string, {
        id: string;
        name: string;
        ventanaId?: string;
        ventanaName?: string;
        count: number;
      }>();
      if (context.role === Role.ADMIN || context.role === Role.VENTANA) {
        tickets.forEach((ticket) => {
          if (ticket.vendedor) {
            const existing = vendedorMap.get(ticket.vendedor.id);
            if (existing) {
              existing.count++;
            } else {
              vendedorMap.set(ticket.vendedor.id, {
                id: ticket.vendedor.id,
                name: ticket.vendedor.name,
                ventanaId: ticket.vendedor.ventanaId || undefined,
                ventanaName: ticket.vendedor.ventana?.name,
                count: 1,
              });
            }
          }
        });
      }

      // Agrupar por ventana (solo para ADMIN)
      const ventanaMap = new Map<string, {
        id: string;
        name: string;
        code?: string;
        count: number;
      }>();
      if (context.role === Role.ADMIN) {
        tickets.forEach((ticket) => {
          // Usar ventanaId directo del ticket o del vendedor
          const ventanaId = ticket.ventanaId || ticket.vendedor?.ventanaId;
          if (ventanaId) {
            // Priorizar ventana directa del ticket, sino usar la del vendedor
            const ventana = ticket.ventana || ticket.vendedor?.ventana;
            if (ventana) {
              const existing = ventanaMap.get(ventanaId);
              if (existing) {
                existing.count++;
              } else {
                ventanaMap.set(ventanaId, {
                  id: ventanaId,
                  name: ventana.name,
                  code: 'code' in ventana ? ventana.code || undefined : undefined,
                  count: 1,
                });
              }
            }
          }
        });
      }

      // Construir respuesta
      const loterias = Array.from(loteriaMap.values())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((l) => ({
          id: l.id,
          name: l.name,
          ticketCount: l.count,
        }));

      const sorteos = Array.from(sorteoMap.values())
        .sort((a, b) => b.scheduledAt.getTime() - a.scheduledAt.getTime())
        .map((s) => ({
          id: s.id,
          name: s.name,
          loteriaId: s.loteriaId,
          loteriaName: s.loteriaName,
          scheduledAt: s.scheduledAt.toISOString(),
          ticketCount: s.count,
        }));

      // Filtrar multiplicadores según política de comisión para vendedores
      const multipliersFiltered = multipliers
        .filter((m) => {
          // Para vendedores, solo incluir multiplicadores permitidos
          if (context.role === Role.VENDEDOR && allowedMultiplierIds) {
            return allowedMultiplierIds.has(m.id);
          }
          // Para otros roles, incluir todos los multiplicadores que tienen tickets
          return multiplierMap.has(m.id);
        })
        .map((m) => {
          const multiplierData = multiplierMap.get(m.id);
          // ticketCount es el número de tickets únicos que tienen este multiplicador
          const ticketCount = multiplierData?.ticketIds.size || 0;
          return {
            id: m.id,
            name: m.name,
            valueX: m.valueX,
            loteriaId: m.loteriaId,
            loteriaName: m.loteria?.name || '',
            ticketCount, //  Cuenta tickets únicos, no jugadas
          };
        })
        .sort((a, b) => a.valueX - b.valueX);

      const vendedores = Array.from(vendedorMap.values())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((v) => ({
          id: v.id,
          name: v.name,
          ventanaId: v.ventanaId,
          ventanaName: v.ventanaName,
          ticketCount: v.count,
        }));

      const ventanas = Array.from(ventanaMap.values())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((v) => ({
          id: v.id,
          name: v.name,
          code: v.code,
          ticketCount: v.count,
        }));

      return {
        loterias,
        sorteos,
        multipliers: multipliersFiltered,
        vendedores,
        ventanas, //  NUEVO: Ventanas para filtro de Admin
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
