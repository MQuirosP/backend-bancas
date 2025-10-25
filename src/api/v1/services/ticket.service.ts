import { ActivityType } from "@prisma/client";
import TicketRepository from "../../../repositories/ticket.repository";
import ActivityService from "../../../core/activity.service";
import logger from "../../../core/logger";
import { AppError } from "../../../core/errors";
import prisma from "../../../core/prismaClient";
import { RestrictionRuleRepository } from "../../../repositories/restrictionRule.repository";
import { isWithinSalesHours, validateTicketAgainstRules } from "../../../utils/loteriaRules";

const CUTOFF_GRACE_MS = 5000;

export const TicketService = {
  async create(data: any, userId: string, requestId?: string) {
    try {
      const { loteriaId, sorteoId } = data;
      if (!loteriaId || !sorteoId) throw new AppError("Missing loteriaId/sorteoId", 400);

      // Ventana del vendedor
      const seller = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, ventanaId: true },
      });
      if (!seller?.ventanaId) throw new AppError("El vendedor no tiene una Ventana asignada", 400);
      const ventanaId = seller.ventanaId;

      // Ventana válida
      const ventana = await prisma.ventana.findUnique({
        where: { id: ventanaId },
        select: { id: true, bancaId: true, isActive: true },
      });
      if (!ventana || !ventana.isActive) throw new AppError("La Ventana no existe o está inactiva", 404);

      // Sorteo válido
      const sorteo = await prisma.sorteo.findUnique({
        where: { id: sorteoId },
        select: { id: true, scheduledAt: true, status: true, loteriaId: true },
      });
      if (!sorteo) throw new AppError("Sorteo no encontrado", 404);

      // ⏱ cutoff efectivo (rules → RestrictionRuleRepository)
      const cutoff = await RestrictionRuleRepository.resolveSalesCutoff({
        bancaId: ventana.bancaId,
        ventanaId,
        userId,
        defaultCutoff: 5,
      });

      const now = new Date();
      const cutoffMs = cutoff.minutes * 60_000;
      const limitTime = new Date(sorteo.scheduledAt.getTime() - cutoffMs);
      const effectiveLimitTime = new Date(limitTime.getTime() + CUTOFF_GRACE_MS);

      logger.info({
        layer: "service",
        action: "TICKET_CUTOFF_DIAG",
        userId,
        requestId,
        payload: {
          cutOff: { minutes: cutoff.minutes, source: cutoff.source },
          nowISO: now.toISOString(),
          scheduledAtISO: sorteo.scheduledAt.toISOString(),
          limitTimeISO: limitTime.toISOString(),
          effectiveLimitTimeISO: effectiveLimitTime.toISOString(),
          sorteoStatus: sorteo.status,
        },
      });

      if (now >= effectiveLimitTime) {
        const minsLeft = Math.max(0, Math.ceil((sorteo.scheduledAt.getTime() - now.getTime()) / 60_000));
        throw new AppError(
          `Venta bloqueada: faltan ${minsLeft} min para el sorteo (cutoff=${cutoff.minutes} min, source=${cutoff.source})`,
          409
        );
      }

      // 🎯 Jugadas (el validador ya corrió)
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

      // 🔒 Validaciones por rulesJson de la Lotería (horarios + reglas de jugadas)
      const loteria = await prisma.loteria.findUnique({
        where: { id: loteriaId },
        select: { name: true, rulesJson: true },
      });
      const rules = (loteria?.rulesJson ?? {}) as any;

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

      // 🧩 Normalizar para repo
      const ticket = await TicketRepository.create(
        {
          loteriaId,
          sorteoId,
          ventanaId,
          totalAmount: 0,
          jugadas: jugadasIn.map((j) => {
            const type = (j.type ?? "NUMERO") as "NUMERO" | "REVENTADO";
            const isNumero = type === "NUMERO";
            const number = isNumero ? j.number! : (j.reventadoNumber ?? j.number)!;
            return {
              type,
              number,
              reventadoNumber: isNumero ? null : number,
              amount: j.amount,
              multiplierId: "",
              finalMultiplierX: 0,
            };
          }),
        } as any,
        userId
      );

      await ActivityService.log({
        userId,
        action: ActivityType.TICKET_CREATE,
        targetType: "TICKET",
        targetId: ticket.id,
        details: {
          ticketNumber: ticket.ticketNumber,
          totalAmount: ticket.totalAmount,
          jugadas: ticket.jugadas.length,
        },
        requestId,
        layer: "service",
      });

      logger.info({
        layer: "service",
        action: "TICKET_CREATE",
        userId,
        requestId,
        payload: { ticketId: ticket.id, totalAmount: ticket.totalAmount, jugadas: ticket.jugadas.length },
      });

      return ticket;
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
    return TicketRepository.getById(id);
  },

  async list(page = 1, pageSize = 10, filters: any = {}) {
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
};

export default TicketService;
