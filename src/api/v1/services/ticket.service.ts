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
    // =======================================================
    // 0. Normalización de entrada y verificaciones previas
    // =======================================================
    const { bancaId, ventanaId, loteriaId, sorteoId } = data;
    if (!bancaId || !ventanaId || !loteriaId || !sorteoId) {
      throw new AppError("Missing bancaId/ventanaId/loteriaId/sorteoId", 400);
    }

    const jugadasIn: Array<{
      type?: "NUMERO" | "REVENTADO";
      number: string;
      reventadoNumber?: string | null;
      amount: number;
      multiplierId?: string;        // será completado abajo
      finalMultiplierX?: number;    // será completado abajo
    }> = Array.isArray(data.jugadas) ? data.jugadas : [];

    if (jugadasIn.length === 0) {
      throw new AppError("At least one jugada is required", 400);
    }

    // =======================================================
    // 1. Reglas de pairing y coherencia REVENTADO
    //    - REVENTADO sólo válido si existe NUMERO del mismo número
    //    - reventadoNumber debe ser igual a number
    // =======================================================
    const numerosEnTicket = new Set(
      jugadasIn.filter(j => (j.type ?? "NUMERO") === "NUMERO").map(j => j.number)
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
        if (!numerosEnTicket.has(j.number)) {
          throw new AppError(
            `A NUMERO bet for ${j.number} must exist to allow REVENTADO`,
            400
          );
        }
      }
    }

    // =======================================================
    // 2. Validación jerárquica de restricciones (como tenías)
    // =======================================================
    const at = new Date();

    // por jugada
    for (const j of jugadasIn) {
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

    // total por ticket
    const total = jugadasIn.reduce((acc: number, j: any) => acc + j.amount, 0);
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
    // 3. Resolver X efectivo y multiplierId para NUMERO
    //    - finalMultiplierX = override(user) ?? base(banca-loteria)
    //    - multiplierId = LoteriaMultiplier(name="Base") activo
    //    - REVENTADO: finalMultiplierX=0 y multiplierId dummy (repo lo sobrescribe)
    // =======================================================
    // base banca-loteria
    const bls = await prisma.bancaLoteriaSetting.findUnique({
      where: { bancaId_loteriaId: { bancaId, loteriaId } },
      select: { baseMultiplierX: true },
    });
    if (!bls?.baseMultiplierX && bls?.baseMultiplierX !== 0) {
      throw new AppError(
        `Missing baseMultiplierX for bancaId=${bancaId} & loteriaId=${loteriaId}`,
        400
      );
    }

    // override user (opcional)
    const uo = await prisma.userMultiplierOverride.findUnique({
      where: {
        userId_loteriaId_multiplierType: {
          userId,
          loteriaId,
          multiplierType: "Base",
        },
      },
      select: { baseMultiplierX: true },
    });

    const effectiveBaseX = (uo?.baseMultiplierX ?? bls.baseMultiplierX)!;

    // multiplier "Base" para conectar en NUMERO
    const baseMultiplierRow = await prisma.loteriaMultiplier.findFirst({
      where: { loteriaId, isActive: true, name: "Base" },
      select: { id: true },
    });
    if (!baseMultiplierRow) {
      throw new AppError(
        `LoteriaMultiplier "Base" not found for loteriaId=${loteriaId}. Seed it first.`,
        400
      );
    }

    // preparar jugadas con los campos requeridos por el repo
    const jugadasPrepared = jugadasIn.map((j) => {
      const type = j.type ?? "NUMERO";
      if (type === "NUMERO") {
        return {
          type: "NUMERO" as const,
          number: j.number,
          reventadoNumber: null,
          amount: j.amount,
          multiplierId: baseMultiplierRow.id,
          finalMultiplierX: effectiveBaseX,
        };
      } else {
        // REVENTADO: X se fija en evaluación; el repo pondrá placeholder al multiplierId
        return {
          type: "REVENTADO" as const,
          number: j.number,
          reventadoNumber: j.reventadoNumber ?? j.number,
          amount: j.amount,
          multiplierId: "DYNAMIC",  // dummy; será ignorado y sustituido en el repo
          finalMultiplierX: 0,
        };
      }
    });

    // =======================================================
    // 4. Crear ticket (repo maneja secuencia, restricciones extra y tx)
    // =======================================================
    const payloadForRepo = {
      bancaId,
      ventanaId,
      loteriaId,
      sorteoId,
      totalAmount: total,
      jugadas: jugadasPrepared,
    };

    const ticket = await TicketRepository.create(payloadForRepo as any, userId);

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
