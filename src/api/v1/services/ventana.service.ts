import { ActivityType } from "@prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import ActivityService from "../../../core/activity.service";
import VentanaRepository from "../../../repositories/ventana.repository";
import { CreateVentanaInput, UpdateVentanaInput } from "../dto/ventana.dto";

/**
 * Deep merge de configuraciones (parcial)
 * newSettings override los valores en currentSettings, manteniendo lo demás
 */
function deepMergeSettings(
  currentSettings: Record<string, any>,
  newSettings: Record<string, any>
): Record<string, any> {
  const merged = { ...currentSettings };

  for (const key in newSettings) {
    const newVal = newSettings[key];

    // Si es null, se borra del merged (null = "remover este campo")
    if (newVal === null || newVal === undefined) {
      delete merged[key];
    } else if (typeof newVal === 'object' && newVal !== null && !Array.isArray(newVal)) {
      // Si es un objeto anidado, mergear recursivamente
      const currentVal = merged[key];
      if (typeof currentVal === 'object' && currentVal !== null && !Array.isArray(currentVal)) {
        merged[key] = deepMergeSettings(currentVal, newVal);
      } else {
        // Si el actual no es objeto, reemplazar completamente
        merged[key] = newVal;
      }
    } else {
      // Para primitivos o arrays, reemplazar completamente
      merged[key] = newVal;
    }
  }

  return merged;
}

export const VentanaService = {
  async create(data: CreateVentanaInput, userId: string) {
    const banca = await prisma.banca.findUnique({
      where: { id: data.bancaId },
    });
    if (!banca) throw new AppError("La banca asociada no existe", 404);

    const existing = await VentanaRepository.findByCode(data.code);
    if (existing) throw new AppError("El código de la ventana ya existe", 400);

    const ventana = await VentanaRepository.create(data);

    await ActivityService.log({
      userId,
      action: ActivityType.VENTANA_CREATE,
      targetType: "VENTANA",
      targetId: ventana.id,
      details: data,
    });

    return ventana;
  },

  async update(id: string, data: UpdateVentanaInput, userId: string) {
    const existing = await VentanaRepository.findById(id);
    if (!existing)
      throw new AppError("Ventana no encontrada", 404);

    if (data.code && data.code !== existing.code) {
      const dup = await VentanaRepository.findByCode(data.code);
      if (dup) throw new AppError("El código de la ventana ya existe", 400);
    }

    const toUpdate: any = { ...data };
    delete toUpdate.bancaId;

    // settings: merge parcial con los settings existentes
    if ((data as any).settings !== undefined) {
      const currentVentana = await prisma.ventana.findUnique({
        where: { id },
        select: { settings: true },
      });

      const currentSettings = currentVentana?.settings as Record<string, any> | null || {};

      if ((data as any).settings === null) {
        // Si envían null explícitamente, limpiar settings
        toUpdate.settings = null;
      } else {
        // Merge parcial
        const mergedSettings = deepMergeSettings(currentSettings, (data as any).settings);
        toUpdate.settings = mergedSettings;
      }
    }

    const ventana = await VentanaRepository.update(id, toUpdate);

    await ActivityService.log({
      userId,
      action: ActivityType.VENTANA_UPDATE,
      targetType: "VENTANA",
      targetId: id,
      details: data,
    });

    return ventana;
  },

  async softDelete(id: string, userId: string, reason?: string) {
    const ventana = await VentanaRepository.softDelete(id, userId, reason);

    await ActivityService.log({
      userId,
      action: ActivityType.VENTANA_DELETE,
      targetType: "VENTANA",
      targetId: id,
      details: { reason },
    });

    return ventana;
  },

  // services/ventana.service.ts
async findAll(page?: number, pageSize?: number, search?: string, isActive?: boolean) {
  const p  = page && page > 0 ? page : 1
  const ps = pageSize && pageSize > 0 ? pageSize : 10

  const { data, total } = await VentanaRepository.list(
    p, ps, search?.trim() || undefined,
  )

  return {
    data,
    meta: { total, page: p, pageSize: ps, totalPages: Math.max(1, Math.ceil(total / ps)) },
  }
},

  async findById(id: string) {
    const ventana = await VentanaRepository.findById(id);
    if (!ventana || !ventana.id)
      throw new AppError("Ventana no encontrada", 404);
    return ventana;
  },

  async restore(id: string, userId: string, reason?: string) {
    const ventana = await VentanaRepository.restore(id);

    await ActivityService.log({
      userId,
      action: ActivityType.VENTANA_RESTORE,
      targetType: "VENTANA",
      targetId: id,
      details: { reason },
    });

    return ventana;
  },
};
