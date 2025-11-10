import { ActivityType } from "@prisma/client";
import ActivityService from "../../../core/activity.service";
import { AppError } from "../../../core/errors";
import {
  CreateRestrictionRuleInput,
  UpdateRestrictionRuleInput,
} from "../dto/restrictionRule.dto";
import { RestrictionRuleRepository } from "../../../repositories/restrictionRule.repository";
import prisma from "../../../core/prismaClient";

/**
 * Normaliza y valida el campo number
 * - Si es string, lo convierte a array con un elemento
 * - Si es array, lo valida y elimina duplicados
 * - Retorna array de strings únicos ordenados
 */
function normalizeAndValidateNumbers(
  number: string | string[] | undefined
): string[] {
  if (!number) return [];
  
  // Normalizar a array
  const numbers = Array.isArray(number) ? number : [number];
  
  // Validar cada número
  const validated: string[] = [];
  for (const num of numbers) {
    if (typeof num !== "string") {
      throw new AppError("Cada número debe ser un string", 400);
    }
    
    const trimmed = num.trim();
    if (!/^\d{2}$/.test(trimmed)) {
      throw new AppError(
        `Número inválido: '${num}'. Debe ser de 2 dígitos (00-99)`,
        400
      );
    }
    
    const numValue = Number(trimmed);
    if (numValue < 0 || numValue > 99) {
      throw new AppError(
        `Número fuera de rango: '${num}'. Debe estar entre 00 y 99`,
        400
      );
    }
    
    validated.push(trimmed);
  }
  
  // Eliminar duplicados y ordenar
  const unique = [...new Set(validated)];
  if (unique.length !== validated.length) {
    throw new AppError("No se permiten números duplicados en el array", 400);
  }
  
  return unique.sort((a, b) => Number(a) - Number(b));
}

export const RestrictionRuleService = {
  async create(actorId: string, data: CreateRestrictionRuleInput) {
    const isLotteryRule = Boolean(data.loteriaId || data.multiplierId);

    if (isLotteryRule) {
      if (!data.loteriaId || !data.multiplierId) {
        throw new AppError(
          "Para restricciones de lotería/multiplicador se requiere loteriaId y multiplierId",
          400
        );
      }

      const multiplier = await prisma.loteriaMultiplier.findUnique({
        where: { id: data.multiplierId },
        select: {
          id: true,
          loteriaId: true,
          isActive: true,
          name: true,
        },
      });

      if (!multiplier) {
        throw new AppError("Multiplicador no encontrado", 404);
      }

      if (multiplier.loteriaId !== data.loteriaId) {
        throw new AppError(
          "El multiplicador no pertenece a la lotería indicada",
          400
        );
      }

      if (!multiplier.isActive) {
        throw new AppError(
          "El multiplicador indicado está inactivo",
          400
        );
      }

      const message =
        (data.message && data.message.trim()) ||
        `El multiplicador '${multiplier.name ?? ""}' está restringido para esta lotería.`;

      const created = await RestrictionRuleRepository.create({
        bancaId: data.bancaId ?? null,
        ventanaId: data.ventanaId ?? null,
        userId: data.userId ?? null,
        number: null,
        maxAmount: null,
        maxTotal: null,
        salesCutoffMinutes: null,
        appliesToDate: data.appliesToDate ?? null,
        appliesToHour: data.appliesToHour ?? null,
        loteriaId: data.loteriaId,
        multiplierId: data.multiplierId,
        message,
      });

      await ActivityService.log({
        userId: actorId,
        action: ActivityType.SYSTEM_ACTION,
        targetType: "RESTRICTION_RULE",
        targetId: created.id,
        details: { created },
        layer: "service",
      });

      return created;
    }

    // Normalizar number a array
    const numbers = normalizeAndValidateNumbers(data.number);
    
    // Extraer number del data para crear el payload base
    const { number: _, ...baseData } = data;
    
    // Si no hay números, crear una sola restricción sin number
    if (numbers.length === 0) {
      const created = await RestrictionRuleRepository.create({
        ...baseData,
        number: null,
        message: data.message?.trim() ?? null,
        loteriaId: null,
        multiplierId: null,
      });
      await ActivityService.log({
        userId: actorId,
        action: ActivityType.SYSTEM_ACTION,
        targetType: "RESTRICTION_RULE",
        targetId: created.id,
        details: { created },
        layer: "service",
      });
      return created;
    }
    
    // Si hay números, crear una restricción por cada número
    const restrictions = await Promise.all(
      numbers.map((num) =>
        RestrictionRuleRepository.create({
          ...baseData,
          number: num, // Cada registro tiene un solo número
          message: data.message?.trim() ?? null,
          loteriaId: null,
          multiplierId: null,
        })
      )
    );
    
    // Log para todas las restricciones creadas
    await Promise.all(
      restrictions.map((restriction) =>
        ActivityService.log({
          userId: actorId,
          action: ActivityType.SYSTEM_ACTION,
          targetType: "RESTRICTION_RULE",
          targetId: restriction.id,
          details: { created: restriction, batchCount: restrictions.length },
          layer: "service",
        })
      )
    );
    
    // Retornar el primer registro (Opción A según el documento)
    return restrictions[0];
  },

  async update(actorId: string, id: string, data: UpdateRestrictionRuleInput) {
    const current = await RestrictionRuleRepository.findById(id);
    if (!current) throw new AppError("RestrictionRule not found", 404);

    const loteriaId = data.loteriaId ?? current.loteriaId ?? null;
    const multiplierId = data.multiplierId ?? current.multiplierId ?? null;
    const isLotteryRule = Boolean(loteriaId || multiplierId);

    if (isLotteryRule) {
      if (!loteriaId || !multiplierId) {
        throw new AppError(
          "Para restricciones de lotería/multiplicador se requiere loteriaId y multiplierId",
          400
        );
      }

      const multiplier = await prisma.loteriaMultiplier.findUnique({
        where: { id: multiplierId },
        select: {
          id: true,
          loteriaId: true,
          isActive: true,
          name: true,
        },
      });

      if (!multiplier) {
        throw new AppError("Multiplicador no encontrado", 404);
      }
      if (multiplier.loteriaId !== loteriaId) {
        throw new AppError(
          "El multiplicador no pertenece a la lotería indicada",
          400
        );
      }
      if (!multiplier.isActive) {
        throw new AppError(
          "El multiplicador indicado está inactivo",
          400
        );
      }
    }

    const payload: UpdateRestrictionRuleInput = {
      ...data,
      message:
        data.message === undefined
          ? undefined
          : data.message === null
            ? null
            : data.message.trim(),
    };

    const updated = await RestrictionRuleRepository.update(id, payload);
    await ActivityService.log({
      userId: actorId,
      action: ActivityType.SYSTEM_ACTION,
      targetType: "RESTRICTION_RULE",
      targetId: id,
      details: { updated },
      layer: "service",
    });
    return updated;
  },

  async remove(actorId: string, id: string, reason?: string) {
    const deleted = await RestrictionRuleRepository.softDelete(
      id,
      actorId,
      reason
    );
    await ActivityService.log({
      userId: actorId,
      action: ActivityType.SOFT_DELETE,
      targetType: "RESTRICTION_RULE",
      targetId: id,
      details: { reason },
      layer: "service",
    });
    return deleted;
  },

  async restore(actorId: string, id: string) {
    const restored = await RestrictionRuleRepository.restore(id);
    await ActivityService.log({
      userId: actorId,
      action: ActivityType.RESTORE,
      targetType: "RESTRICTION_RULE",
      targetId: id,
      details: null,
      layer: "service",
    });
    return restored;
  },

  async getById(id: string) {
    const rule = await RestrictionRuleRepository.findById(id);
    if (!rule) throw new AppError("RestrictionRule not found", 404);
    return rule;
  },

  async list(query: any) {
    return RestrictionRuleRepository.list(query);
  },
};
