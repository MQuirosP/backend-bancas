import { ActivityType } from "@prisma/client";
import ActivityService from "../../../core/activity.service";
import { AppError } from "../../../core/errors";
import {
  CreateRestrictionRuleInput,
  UpdateRestrictionRuleInput,
} from "../dto/restrictionRule.dto";
import { RestrictionRuleRepository } from "../../../repositories/restrictionRule.repository";
import prisma from "../../../core/prismaClient";
import { getCRLocalComponents } from "../../../utils/businessDate";

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
    if (!/^\d{1,3}$/.test(trimmed)) {
      throw new AppError(
        `Número inválido: '${num}'. Debe ser numérico (0-999)`,
        400
      );
    }

    const numValue = Number(trimmed);
    if (numValue < 0 || numValue > 999) {
      throw new AppError(
        `Número fuera de rango: '${num}'. Debe estar entre 0 y 999`,
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

    // Si isAutoDate es true, crear una sola restricción sin number (se actualiza automáticamente)
    if (data.isAutoDate) {
      const created = await RestrictionRuleRepository.create({
        bancaId: data.bancaId ?? null,
        ventanaId: data.ventanaId ?? null,
        userId: data.userId ?? null,
        isActive: data.isActive ?? true,
        isAutoDate: true,
        number: null, // Se actualizará automáticamente por el cron job
        maxAmount: data.maxAmount ?? null,
        maxTotal: data.maxTotal ?? null,
        baseAmount: data.baseAmount ?? null,
        salesPercentage: data.salesPercentage ?? null,
        appliesToVendedor: data.appliesToVendedor ?? false,
        appliesToDate: data.appliesToDate ?? null,
        appliesToHour: data.appliesToHour ?? null,
        salesCutoffMinutes: null,
        message: data.message?.trim() ?? null,
        loteriaId: null,
        multiplierId: null,
      });
      await ActivityService.log({
        userId: actorId,
        action: ActivityType.SYSTEM_ACTION,
        targetType: "RESTRICTION_RULE",
        targetId: created.id,
        details: { created, isAutoDate: true },
        layer: "service",
      });
      return created;
    }

    // Normalizar number a array
    const numbers = normalizeAndValidateNumbers(data.number);

    // Si no hay números, crear una sola restricción sin number
    if (numbers.length === 0) {
      const created = await RestrictionRuleRepository.create({
        bancaId: data.bancaId ?? null,
        ventanaId: data.ventanaId ?? null,
        userId: data.userId ?? null,
        isActive: data.isActive ?? true,
        isAutoDate: data.isAutoDate ?? false,
        number: null,
        maxAmount: data.maxAmount ?? null,
        maxTotal: data.maxTotal ?? null,
        baseAmount: data.baseAmount ?? null,
        salesPercentage: data.salesPercentage ?? null,
        appliesToVendedor: data.appliesToVendedor ?? false,
        appliesToDate: data.appliesToDate ?? null,
        appliesToHour: data.appliesToHour ?? null,
        salesCutoffMinutes: data.salesCutoffMinutes ?? null,
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
          bancaId: data.bancaId ?? null,
          ventanaId: data.ventanaId ?? null,
          userId: data.userId ?? null,
          isActive: data.isActive ?? true,
          isAutoDate: data.isAutoDate ?? false,
          number: num, // Cada registro tiene un solo número
          maxAmount: data.maxAmount ?? null,
          maxTotal: data.maxTotal ?? null,
          baseAmount: data.baseAmount ?? null,
          salesPercentage: data.salesPercentage ?? null,
          appliesToVendedor: data.appliesToVendedor ?? false,
          appliesToDate: data.appliesToDate ?? null,
          appliesToHour: data.appliesToHour ?? null,
          salesCutoffMinutes: data.salesCutoffMinutes ?? null,
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

  async getCronHealth() {
    // Ejecutar función SQL que retorna el estado del cron job
    const result = await prisma.$queryRaw<
      Array<{
        job_name: string;
        last_success: Date | null;
        hours_since_last_run: number | null;
        is_healthy: boolean;
        expected_number: string;
        current_number: string;
        mismatch_detected: boolean;
      }>
    >`SELECT * FROM check_cron_health()`;

    // Si no hay resultados, retornar un objeto por defecto
    if (!result || result.length === 0) {
      const crNow = getCRLocalComponents(new Date());
      const expectedDay = String(crNow.day).padStart(2, "0");
      return [
        {
          job_name: "update_auto_restrictions",
          last_success: null,
          hours_since_last_run: null,
          is_healthy: false,
          expected_number: expectedDay,
          current_number: "N/A",
          mismatch_detected: false,
        },
      ];
    }

    return result.map((row) => ({
      job_name: row.job_name,
      last_success: row.last_success,
      hours_since_last_run: row.hours_since_last_run,
      is_healthy: row.is_healthy,
      expected_number: row.expected_number,
      current_number: row.current_number,
      mismatch_detected: row.mismatch_detected,
    }));
  },

  async executeCronManually() {
    // Ejecutar manualmente la función de actualización
    try {
      await prisma.$executeRawUnsafe(`SELECT update_auto_date_restrictions();`);

      // Obtener el último log para retornar información
      const lastLog = await prisma.$queryRaw<Array<{
        id: string;
        job_name: string;
        status: string;
        executed_at: Date;
        affected_rows: number | null;
        effective_number: string | null;
        error_message: string | null;
      }>>`
        SELECT id, job_name, status, executed_at, affected_rows, effective_number, error_message
        FROM cron_execution_logs
        WHERE job_name = 'update_auto_restrictions'
        ORDER BY executed_at DESC
        LIMIT 1
      `;

      if (lastLog && lastLog.length > 0) {
        const log = lastLog[0];
        return {
          success: log.status === 'success',
          executed_at: log.executed_at,
          affected_rows: log.affected_rows,
          effective_number: log.effective_number,
          error_message: log.error_message,
        };
      }

      return {
        success: true,
        executed_at: new Date(),
        affected_rows: null,
        effective_number: null,
        error_message: null,
      };
    } catch (error: any) {
      // Si hay error, obtener el último log de error
      const lastErrorLog = await prisma.$queryRaw<Array<{
        error_message: string | null;
        executed_at: Date;
      }>>`
        SELECT error_message, executed_at
        FROM cron_execution_logs
        WHERE job_name = 'update_auto_restrictions'
          AND status = 'error'
        ORDER BY executed_at DESC
        LIMIT 1
      `;

      throw new AppError(
        error.message || 'Error ejecutando cron manualmente',
        500,
        {
          error_message: lastErrorLog?.[0]?.error_message || error.message,
          executed_at: lastErrorLog?.[0]?.executed_at || new Date(),
        }
      );
    }
  },

  /**
   * Obtiene todas las restricciones visibles para un vendedor.
   * - **general**: reglas que no están asociadas a un usuario
   *               (pueden estar vinculadas a banca, ventana o ser globales).
   * - **vendorSpecific**: reglas cuyo `userId` coincide con el vendedor.
   */
  async forVendor(vendorId: string, bancaId: string, ventanaId: string | null) {
    // 1️⃣ Restricciones generales (Globales + Banca + Ventana)
    const general = await RestrictionRuleRepository.findGeneralRules(bancaId, ventanaId);

    // 2️⃣ Restricciones específicas del vendedor
    const vendorSpecific = await RestrictionRuleRepository.list({
      userId: vendorId,
    });

    return {
      general,
      vendorSpecific: vendorSpecific.data,
    };
  },
};
