import { ActivityType } from "@prisma/client";
import TicketRepository from "../../../repositories/ticket.repository";
import ActivityService from "../../../core/activity.service";
import logger from "../../../core/logger";
import { AppError } from "../../../core/errors";
import { RestrictionRuleRepository } from "../../../repositories/restrictionRule.repository";
import prisma from "../../../core/prismaClient";

export const TicketService = {
  /**
   * Crear ticket (con validación de restricciones)
   */
  async create(data: any, userId: string, requestId?: string) {
    try {
      const { ventanaId, loteriaId, sorteoId } = data;
      if (!ventanaId || !loteriaId || !sorteoId) {
        throw new AppError("Missing ventanaId/loteriaId/sorteoId", 400);
      }

      const jugadasIn: Array<{
        type?: "NUMERO" | "REVENTADO";
        number: string;
        reventadoNumber?: string | null;
        amount: number;
      }> = Array.isArray(data.jugadas) ? data.jugadas : [];
      if (jugadasIn.length === 0) {
        throw new AppError("At least one jugada is required", 400);
      }

      // Coherencia mínima REVENTADO (pairing con NUMERO y mismo número)
      const numeros = new Set(
        jugadasIn
          .filter((j) => (j.type ?? "NUMERO") === "NUMERO")
          .map((j) => j.number)
      );
      for (const j of jugadasIn) {
        const type = j.type ?? "NUMERO";
        if (type === "REVENTADO") {
          if (!j.reventadoNumber || j.reventadoNumber !== j.number) {
            throw new AppError(
              `REVENTADO must reference the same number (reventadoNumber === number) for ${j.number}`,
              400
            );
          }
          if (!numeros.has(j.number)) {
            throw new AppError(
              `A NUMERO bet for ${j.number} must exist to allow REVENTADO`,
              400
            );
          }
        }
      }

      // El total lo calcula el repo; aquí solo pasamos las jugadas tal cual
      const ticket = await TicketRepository.create(
        {
          loteriaId,
          sorteoId,
          ventanaId,
          // totalAmount y multiplierId/finalMultiplierX se resuelven en repo/tx
          totalAmount: 0,
          jugadas: jugadasIn.map((j) => ({
            type: (j.type ?? "NUMERO") as "NUMERO" | "REVENTADO",
            number: j.number,
            reventadoNumber:
              j.reventadoNumber ?? (j.type === "REVENTADO" ? j.number : null),
            amount: j.amount,
            multiplierId: "", // placeholder, repo lo resolverá
            finalMultiplierX: 0, // repo congelará valor efectivo para NUMERO
          })),
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
        payload: {
          ticketId: ticket.id,
          totalAmount: ticket.totalAmount,
          jugadas: ticket.jugadas.length,
        },
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

  /**
   * Obtener ticket por ID
   */
  async getById(id: string) {
    return TicketRepository.getById(id);
  },

  /**
   * Listar tickets
   */
  async list(page = 1, pageSize = 10, filters: any = {}) {
    return TicketRepository.list(page, pageSize, filters);
  },

  /**
   * Cancelar ticket (soft delete)
   */
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
