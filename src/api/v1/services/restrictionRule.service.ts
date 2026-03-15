import { ActivityType } from "@prisma/client";
import ActivityService from "../../../core/activity.service";
import { AppError } from "../../../core/errors";
import {
  CreateRestrictionRuleInput,
  UpdateRestrictionRuleInput,
} from "../dto/restrictionRule.dto";
import { RestrictionRuleRepository } from "../../../repositories/restrictionRule.repository";
import prisma from "../../../core/prismaClient";
import { withConnectionRetry } from "../../../core/withConnectionRetry";
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
    let multiplierName = "";

    // 1. Validaciones previas para reglas de Lotería/Multiplicador
    if (isLotteryRule) {
      if (!data.loteriaId || !data.multiplierId) {
        throw new AppError(
          "Para restricciones de lotería/multiplicador se requiere loteriaId y multiplierId",
          400
        );
      }

      const multiplier = await withConnectionRetry(
        () => prisma.loteriaMultiplier.findUnique({
          where: { id: data.multiplierId! },
          select: {
            id: true,
            loteriaId: true,
            isActive: true,
            name: true,
          },
        }),
        { context: 'RestrictionRuleService.create.multiplier' }
      );

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
      multiplierName = multiplier.name || "";
    }

    // 2. Determinar números a procesar (Normalización)
    // Si isAutoDate es true, no procesamos números individuales
    const numbers = data.isAutoDate ? [] : normalizeAndValidateNumbers(data.number);

    // 3. Preparar el Payload Base
    const basePayload: any = {
      bancaId: data.bancaId ?? null,
      ventanaId: data.ventanaId ?? null,
      userId: data.userId ?? null,
      isActive: data.isActive ?? true,
      isAutoDate: data.isAutoDate ?? false,
      maxAmount: data.maxAmount ?? null,
      maxTotal: data.maxTotal ?? null,
      baseAmount: data.baseAmount ?? null,
      salesPercentage: data.salesPercentage ?? null,
      appliesToVendedor: data.appliesToVendedor ?? false,
      appliesToDate: data.appliesToDate ?? null,
      appliesToHour: data.appliesToHour ?? null,
      salesCutoffMinutes: data.salesCutoffMinutes ?? null,
      loteriaId: data.loteriaId ?? null,
      multiplierId: data.multiplierId ?? null,
    };

    // Mensaje por defecto para reglas de multiplicador
    if (isLotteryRule) {
      basePayload.message =
        (data.message && data.message.trim()) ||
        `El multiplicador '${multiplierName}' está restringido para esta lotería.`;
    } else {
      basePayload.message = data.message?.trim() ?? null;
    }

    // 4. Creación de Reglas Transaccional con check de unicidad
    let createdRules: any[] = [];

    await prisma.$transaction(async (tx) => {
      const numbersToProcess = data.isAutoDate ? [null] : numbers.length === 0 ? [null] : numbers;

      for (const num of numbersToProcess) {
        //  PRE-VUELO: Check de unicidad (regla activa idéntica)
        const existing = await tx.restrictionRule.findFirst({
          where: {
            isActive: true,
            number: num,
            userId: basePayload.userId,
            ventanaId: basePayload.ventanaId,
            bancaId: basePayload.bancaId,
            loteriaId: basePayload.loteriaId,
            multiplierId: basePayload.multiplierId,
          },
          select: { id: true }
        });

        if (existing) {
          throw new AppError(
            `Ya existe una regla activa para el número ${num || 'Global'} en este ámbito.`,
            409
          );
        }

        const rule = await tx.restrictionRule.create({
          data: {
            ...basePayload,
            number: num,
          }
        });
        createdRules.push(rule);
      }
    });

    // 5. Invalidar caché e Invalidar logs (fuera de la transacción para no bloquear)
    // invalidateRestrictionCaches ya es llamado por el repository, pero como usamos tx aquí, 
    // debemos asegurarnos de invalidar después.
    const first = createdRules[0];
    if (first) {
      const { invalidateRestrictionCaches } = require("../../../utils/restrictionCache");
      await invalidateRestrictionCaches({
        bancaId: first.bancaId || undefined,
        ventanaId: first.ventanaId || undefined,
        userId: first.userId || undefined,
      });
    }

    // 6. Registro de Actividad
    await Promise.all(
      createdRules.map((rule) =>
        ActivityService.log({
          userId: actorId,
          action: ActivityType.SYSTEM_ACTION,
          targetType: "RESTRICTION_RULE",
          targetId: rule.id,
          details: { created: rule, batchCount: createdRules.length },
          layer: "service",
        })
      )
    );

    return createdRules;
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

      const multiplier = await withConnectionRetry(
        () => prisma.loteriaMultiplier.findUnique({
          where: { id: multiplierId! },
          select: {
            id: true,
            loteriaId: true,
            isActive: true,
            name: true,
          },
        }),
        { context: 'RestrictionRuleService.update.multiplier' }
      );

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

  /**
   * Actualización masiva transaccional
   */
  async bulkUpdate(actorId: string, ids: string[], data: UpdateRestrictionRuleInput) {
    if (!ids || ids.length === 0) throw new AppError("No ids provided", 400);

    const updatedRules = await prisma.$transaction(async (tx) => {
      const results: any[] = [];
      for (const id of ids) {
        const rule = await tx.restrictionRule.update({
          where: { id },
          data: data as any
        });
        results.push(rule);
      }
      return results;
    });

    // Invalidar caché
    const first = updatedRules[0];
    if (first) {
      const { invalidateRestrictionCaches } = require("../../../utils/restrictionCache");
      await invalidateRestrictionCaches({
        bancaId: first.bancaId || undefined,
        ventanaId: first.ventanaId || undefined,
        userId: first.userId || undefined,
      });
    }

    await ActivityService.log({
      userId: actorId,
      action: ActivityType.SYSTEM_ACTION,
      targetType: "RESTRICTION_RULE",
      targetId: ids[0], // Referencia al primero
      details: { bulkUpdate: true, count: ids.length, ids, data },
      layer: "service",
    });

    return updatedRules;
  },

  /**
   * Borrado masivo (desactivación lógica)
   */
  async bulkRemove(actorId: string, ids: string[], reason?: string) {
    if (!ids || ids.length === 0) throw new AppError("No ids provided", 400);

    const deletedRules = await prisma.$transaction(async (tx) => {
      const results: any[] = [];
      for (const id of ids) {
        const rule = await tx.restrictionRule.update({
          where: { id },
          data: { isActive: false }
        });
        results.push(rule);
      }
      return results;
    });

    // Invalidar caché
    const first = deletedRules[0];
    if (first) {
      const { invalidateRestrictionCaches } = require("../../../utils/restrictionCache");
      await invalidateRestrictionCaches({
        bancaId: first.bancaId || undefined,
        ventanaId: first.ventanaId || undefined,
        userId: first.userId || undefined,
      });
    }

    await ActivityService.log({
      userId: actorId,
      action: ActivityType.SOFT_DELETE,
      targetType: "RESTRICTION_RULE",
      targetId: ids[0],
      details: { bulkDelete: true, count: ids.length, ids, reason },
      layer: "service",
    });

    return deletedRules;
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

  /**
   * Visualización Agrupada
   * Agrupa reglas que comparten la misma configuración pero diferentes números.
   */
  async listGrouped(query: any) {
    let repoQuery = { ...query, page: 1, pageSize: 2000 };

    // Si viene un groupKey, lo usamos para filtrar directamente los atributos en el repo
    // Esto es mucho más eficiente y "congruente" que buscar por un solo ID
    // Si viene un groupKey, lo usamos para filtrar directamente los atributos en el repo
    if (query.groupKey) {
        const parts = query.groupKey.split('|');
        if (parts.length >= 14) {
            const [
                userId, ventanaId, bancaId, loteriaId, multiplierId,
                baseAmount, salesPercentage, maxAmount, maxTotal,
                isActive, isAutoDate, appliesToDate, appliesToHour, salesCutoffMinutes
            ] = parts;

            repoQuery = {
                ...repoQuery,
                userId: userId === 'null' ? null : userId,
                ventanaId: ventanaId === 'null' ? null : ventanaId,
                bancaId: bancaId === 'null' ? null : bancaId,
                loteriaId: loteriaId === 'null' ? null : loteriaId,
                multiplierId: multiplierId === 'null' ? null : multiplierId,
                baseAmount: baseAmount === 'null' ? null : parseFloat(baseAmount),
                salesPercentage: salesPercentage === 'null' ? null : parseFloat(salesPercentage),
                maxAmount: maxAmount === 'null' ? null : parseFloat(maxAmount),
                maxTotal: maxTotal === 'null' ? null : parseFloat(maxTotal),
                isActive: isActive === 'true',
                isAutoDate: isAutoDate === 'true',
                appliesToDate: appliesToDate === 'null' ? null : appliesToDate, // Pasar string directamente al repo
                appliesToHour: appliesToHour === 'null' ? null : parseInt(appliesToHour, 10),
                salesCutoffMinutes: salesCutoffMinutes === 'null' ? null : parseInt(salesCutoffMinutes, 10)
            };
        }
    } else if (query.id) {
        // Fallback: búsqueda por ID para identificar el grupo (manteniendo compatibilidad)
        const targetRule = await RestrictionRuleRepository.findById(query.id);
        if (targetRule) {
            repoQuery = {
                ...repoQuery,
                bancaId: targetRule.bancaId || null,
                ventanaId: targetRule.ventanaId || null,
                userId: targetRule.userId || null,
                loteriaId: targetRule.loteriaId || null,
                multiplierId: targetRule.multiplierId || null,
                isActive: targetRule.isActive,
                isAutoDate: targetRule.isAutoDate,
                baseAmount: targetRule.baseAmount,
                salesPercentage: targetRule.salesPercentage,
                maxAmount: targetRule.maxAmount,
                maxTotal: targetRule.maxTotal,
                salesCutoffMinutes: targetRule.salesCutoffMinutes,
                appliesToHour: targetRule.appliesToHour,
            };
        }
    }

    const { data } = await RestrictionRuleRepository.list(repoQuery);
    const groups = new Map<string, any>();

    for (const rule of data) {
        // Generar Key de Agrupación consistente
        const groupKey = [
            rule.userId || 'null',
            rule.ventanaId || 'null',
            rule.bancaId || 'null',
            rule.loteriaId || 'null',
            rule.multiplierId || 'null',
            rule.baseAmount ?? 'null',
            rule.salesPercentage ?? 'null',
            rule.maxAmount ?? 'null',
            rule.maxTotal ?? 'null',
            rule.isActive,
            rule.isAutoDate,
            rule.appliesToDate ? new Date(rule.appliesToDate).toISOString().split('T')[0] : 'null',
            rule.appliesToHour ?? 'null',
            rule.salesCutoffMinutes ?? 'null'
        ].join('|');

        if (groups.has(groupKey)) {
            const entry = groups.get(groupKey);
            entry.ids.push(rule.id);
            if (rule.number) {
                entry.numbers.push(rule.number);
                // Consolidar en el campo 'number' para compatibilidad con el form de edición
                entry.number = entry.numbers.join(', ');
            }
        } else {
            groups.set(groupKey, {
                ...rule,
                groupKey,      // incluir la llave para que el FE pueda navegar por grupo
                ids: [rule.id],
                numbers: rule.number ? [rule.number] : [],
                number: rule.number,
                updatedAt: rule.updatedAt
            });
        }
    }

    let groupedData = Array.from(groups.values()).sort((a: any, b: any) => 
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    // ✅ FILTRO CRÍTICO: Si se pidió un groupKey específico, asegurar que solo devolvemos ESE grupo.
    // Aunque el repoQuery debería hacer el trabajo pesado, el Map/Map Key garantiza la exactitud final.
    if (query.groupKey) {
        groupedData = groupedData.filter(g => g.groupKey === query.groupKey);
    }

    // PAGINACIÓN sobre los datos agrupados
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.max(1, Number(query.pageSize) || 20);
    const total = groupedData.length;
    const pages = Math.ceil(total / pageSize);
    const slice = groupedData.slice((page - 1) * pageSize, page * pageSize);

    return {
        data: slice,
        meta: {
            page,
            pageSize,
            total,
            pages
        }
    };
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

      return {
        success: true,
        executed_at: new Date(),
        affected_rows: null,
        effective_number: null,
        error_message: null,
      };
    } catch (error: any) {
      throw new AppError(
        error.message || 'Error ejecutando cron manualmente',
        500,
        {
          error_message: error.message,
          executed_at: new Date(),
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
    // 1️⃣ Obtener las reglas desde el repositorio
    const general = await RestrictionRuleRepository.findGeneralRules(bancaId, ventanaId);
    const vendorSpecific = await RestrictionRuleRepository.list({
      userId: vendorId,
    });

    // 2️⃣ Función de limpieza
    const cleanRule = (rule: any) => {
      return {
        ...rule,
        // Forzamos scope vacío para evitar que aparezca el nombre arriba a la derecha
        scope: "",

        // Si existe el objeto banca, vaciamos sus campos descriptivos
        banca: rule.banca ? {
          ...rule.banca,
          name: "",
          code: ""
        } : null,

        // Si existe el objeto ventana, vaciamos sus campos descriptivos
        ventana: rule.ventana ? {
          ...rule.ventana,
          name: "",
          code: ""
        } : null,

        // Opcional: limpiar también el objeto user si fuera necesario
        user: rule.user ? {
          ...rule.user,
          name: ""
        } : null
      };
    };

    return {
      general: general.map(cleanRule),
      vendorSpecific: vendorSpecific.data.map(cleanRule),
    };
  },
};
