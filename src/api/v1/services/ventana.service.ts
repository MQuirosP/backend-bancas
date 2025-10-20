import { ActivityType } from "@prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import ActivityService from "../../../core/activity.service";
import VentanaRepository from "../../../repositories/ventana.repository";
import { CreateVentanaInput, UpdateVentanaInput } from "../dto/ventana.dto";

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
    if (!existing || existing.isDeleted)
      throw new AppError("Ventana no encontrada", 404);

    if (data.code && data.code !== existing.code) {
      const dup = await VentanaRepository.findByCode(data.code);
      if (dup) throw new AppError("El código de la ventana ya existe", 400);
    }

    const ventana = await VentanaRepository.update(id, data);

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

  // ✅ ahora acepta `search`
  async findAll(
    page?: number,
    pageSize?: number,
    search?: string,
    isActive?: boolean
  ) {
    const p = page && page > 0 ? page : 1;
    const ps = pageSize && pageSize > 0 ? pageSize : 10;
    const effectiveIsActive = typeof isActive === "boolean" ? isActive : true;

    const { data, total } = await VentanaRepository.list(
      p,
      ps,
      search?.trim() || undefined,
      effectiveIsActive
    );

    // 🔒 Defense-in-depth: never return deleted, and enforce isActive
    const filtered = data.filter(
      (v) => v.isDeleted !== true && (v.isActive ?? true) === effectiveIsActive
    );
    const totalFiltered = filtered.length;
    const totalPages = Math.ceil(totalFiltered / ps);

    return {
      data: filtered,
      meta: {
        total: totalFiltered,
        page: p,
        pageSize: ps,
        totalPages,
        hasNextPage: p < totalPages,
        hasPrevPage: p > 1,
      },
    };
  },

  async findById(id: string) {
    const ventana = await VentanaRepository.findById(id);
    if (!ventana || ventana.isDeleted)
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
