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

      // ✅ Tipado: number es opcional (solo obligatorio para NUMERO)
      const jugadasIn: Array<{
        type?: "NUMERO" | "REVENTADO";
        number?: string; // <- opcional
        reventadoNumber?: string | null;
        amount: number;
      }> = Array.isArray(data.jugadas) ? data.jugadas : [];

      if (jugadasIn.length === 0) {
        throw new AppError("At least one jugada is required", 400);
      }

      // ✅ Construimos el set de números que sí tienen jugada NUMERO
      const numeros = new Set(
        jugadasIn
          .filter((j) => (j.type ?? "NUMERO") === "NUMERO")
          .map((j) => {
            if (!j.number) {
              throw new AppError("NUMERO jugada requires 'number'", 400);
            }
            return j.number;
          })
      );

      // ✅ REVENTADO: solo exigimos que exista la NUMERO para reventadoNumber
      for (const j of jugadasIn) {
        const type = j.type ?? "NUMERO";
        if (type === "REVENTADO") {
          const target = j.reventadoNumber;
          if (!target) {
            throw new AppError("REVENTADO requires 'reventadoNumber'", 400);
          }
          if (!numeros.has(target)) {
            throw new AppError(
              `Debe existir una jugada NUMERO para ${target} en el mismo ticket`,
              400
            );
          }
        }
      }

      // ✅ Mapeo al repo: para REVENTADO, guardamos number = reventadoNumber
      const ticket = await TicketRepository.create(
        {
          loteriaId,
          sorteoId,
          ventanaId,
          totalAmount: 0, // el repo lo calculará
          jugadas: jugadasIn.map((j) => {
            const type = (j.type ?? "NUMERO") as "NUMERO" | "REVENTADO";
            const isNumero = type === "NUMERO";
            const number = isNumero ? j.number! : (j.reventadoNumber as string); // <- clave: usamos reventadoNumber

            return {
              type,
              number, // <- siempre seteado
              reventadoNumber: isNumero ? null : number,
              amount: j.amount,
              multiplierId: "", // repo lo resuelve
              finalMultiplierX: 0, // repo congela el valor para NUMERO
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
