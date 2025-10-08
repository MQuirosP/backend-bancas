import { ActivityType } from "@prisma/client";
import TicketRepository from "../../../repositories/ticket.repository";
import ActivityService from "../../../core/activity.service";
import logger from "../../../core/logger";
import { AppError } from "../../../core/errors";
import { RestrictionRuleRepository } from "../../../repositories/restrictionRule.repository";

export const TicketService = {
  /**
   * Crear ticket (con validación de restricciones)
   */
  async create(data: any, userId: string, requestId?: string) {
    try {
      // =======================================================
      // 1. Validación jerárquica antes de crear el ticket
      // =======================================================
      const { bancaId, ventanaId } = data; // asegúrate que vengan del body
      const jugadas = data.jugadas || [];

      const at = new Date();

      // Validar límites por jugada
      for (const j of jugadas) {
        const limits = await RestrictionRuleRepository.getEffectiveLimits({
          bancaId,
          ventanaId,
          userId,
          number: j.number,
          at,
        });

        if (limits.maxAmount !== null && j.amount > limits.maxAmount) {
          throw new AppError(
            `Límite por jugada excedido para número ${j.number}. Máximo permitido: ${limits.maxAmount}`,
            400
          );
        }
      }

      // Validar límite total por ticket
      const total = jugadas.reduce((acc: number, j: any) => acc + j.amount, 0);
      const totalLimits = await RestrictionRuleRepository.getEffectiveLimits({
        bancaId,
        ventanaId,
        userId,
        number: null,
        at,
      });

      if (totalLimits.maxTotal !== null && total > totalLimits.maxTotal) {
        throw new AppError(
          `Límite total por ticket excedido. Máximo permitido: ${totalLimits.maxTotal}`,
          400
        );
      }

      // =======================================================
      // 2. Crear ticket (coordinando repositorio + auditoría)
      // =======================================================
      const ticket = await TicketRepository.create(data, userId);

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
