import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import ActivityService from "../../../core/activity.service";
import VendedorRepository from "../../../repositories/vendedor.repository";
import { ActivityType, Role } from "@prisma/client";
import { CreateVendedorInput, UpdateVendedorInput } from "../dto/vendedor.dto";
import bcrypt from "bcryptjs";

type CurrentUser = { id: string; role: Role; ventanaId?: string | null };

async function ensureVentanaActive(ventanaId: string) {
  const v = await prisma.ventana.findUnique({ where: { id: ventanaId }, include: { banca: true } });
  if (!v || v.isDeleted) throw new AppError("La Ventana no existe o está eliminada", 404);
  if (!v.banca || v.banca.isDeleted) throw new AppError("La Banca asociada está eliminada", 409);
  return v;
}

function assertCanWriteTarget(current: CurrentUser, targetVentanaId: string) {
  if (current.role === Role.ADMIN) return;
  if (current.role === Role.VENTANA && current.ventanaId === targetVentanaId) return;
  throw new AppError("Forbidden", 403);
}

function assertCanReadList(current: CurrentUser, requestedVentanaId?: string) {
  if (current.role === Role.ADMIN) return;
  if (current.role === Role.VENTANA && (!requestedVentanaId || requestedVentanaId === current.ventanaId)) return;
  if (current.role === Role.VENDEDOR) return; // service convertirá a "solo yo"
  throw new AppError("Forbidden", 403);
}

export const VendedorService = {
  async create(data: CreateVendedorInput, current: CurrentUser) {
    await ensureVentanaActive(data.ventanaId);
    assertCanWriteTarget(current, data.ventanaId);

    const dup = await VendedorRepository.findByUsername(data.username);
    if (dup && !dup.isDeleted) throw new AppError("El username ya está en uso", 400);

    const passwordHash = await bcrypt.hash(data.password, 10);
    const user = await VendedorRepository.create({
      ventanaId: data.ventanaId,
      name: data.name,
      username: data.username,
      code: data.code,
      email: data.email,
      passwordHash,
    });

    await ActivityService.log({
      userId: current.id,
      action: ActivityType.USER_CREATE,
      targetType: "USER",
      targetId: user.id,
      details: { role: Role.VENDEDOR, ventanaId: data.ventanaId },
    });

    return user;
  },

  async update(id: string, data: UpdateVendedorInput, current: CurrentUser) {
    const existing = await VendedorRepository.findById(id);
    if (!existing || existing.isDeleted || existing.role !== Role.VENDEDOR) {
      throw new AppError("Vendedor no encontrado", 404);
    }

    const targetVentanaId = data.ventanaId ?? existing.ventanaId!;
    await ensureVentanaActive(targetVentanaId);
    assertCanWriteTarget(current, targetVentanaId);

    if (data.username && data.username !== existing.username) {
      const dup = await VendedorRepository.findByUsername(data.username);
      if (dup && !dup.isDeleted) throw new AppError("El correo ya está en uso", 400);
    }

    let passwordHash: string | undefined;
    if (data.password) {
      passwordHash = await bcrypt.hash(data.password, 10);
    }

    const user = await VendedorRepository.update(id, {
      ventanaId: data.ventanaId,
      name: data.name,
      email: data.email,
      passwordHash,
    });

    await ActivityService.log({
      userId: current.id,
      action: ActivityType.USER_UPDATE,
      targetType: "USER",
      targetId: id,
      details: { ventanaId: data.ventanaId, emailChanged: !!data.email, passwordChanged: !!data.password },
    });

    return user;
  },

  async softDelete(id: string, current: CurrentUser, reason?: string) {
    const existing = await VendedorRepository.findById(id);
    if (!existing || existing.isDeleted || existing.role !== Role.VENDEDOR) {
      throw new AppError("Vendedor no encontrado", 404);
    }
    assertCanWriteTarget(current, existing.ventanaId!);

    // Política: no eliminar si tiene tickets activos
    const activeTickets = await prisma.ticket.count({
      where: { vendedorId: id, isDeleted: false, status: "ACTIVE" },
    });
    if (activeTickets > 0) {
      throw new AppError("No se puede eliminar: el vendedor tiene tickets activos", 409);
    }

    const user = await VendedorRepository.softDelete(id, current.id, reason);

    await ActivityService.log({
      userId: current.id,
      action: ActivityType.USER_DELETE,
      targetType: "USER",
      targetId: id,
      details: { reason },
    });

    return user;
  },

  async restore(id: string, current: CurrentUser, reason?: string) {
    const existing = await VendedorRepository.findById(id);
    if (!existing) throw new AppError("Vendedor no encontrado", 404);

    // Permisos: ADMIN o VENTANA dueña
    const ventanaId = existing.ventanaId!;
    assertCanWriteTarget(current, ventanaId);

    const user = await VendedorRepository.restore(id);

    await ActivityService.log({
      userId: current.id,
      action: ActivityType.USER_RESTORE,
      targetType: "USER",
      targetId: id,
      details: { reason },
    });

    return user;
  },

  async findAll(current: CurrentUser, page?: number, pageSize?: number, ventanaIdFilter?: string, search?: string) {
    // Permisos de alcance
    assertCanReadList(current, ventanaIdFilter);

    // Escopado por rol:
    if (current.role === Role.VENDEDOR) {
      // Vendedor solo se ve a sí mismo
      const me = await VendedorRepository.findById(current.id);
      const data = me && !me.isDeleted && me.role === Role.VENDEDOR ? [me] : [];
      return { data, meta: { total: data.length, page: 1, pageSize: data.length || 1, totalPages: 1, hasNextPage: false, hasPrevPage: false } };
    }

    const p = page && page > 0 ? page : 1;
    const ps = pageSize && pageSize > 0 ? pageSize : 10;

    // ADMIN: opcional ventanaIdFilter; VENTANA: fuerza su ventanaId
    const ventanaId = current.role === Role.VENTANA ? current.ventanaId || undefined : ventanaIdFilter;

    const { data, total } = await VendedorRepository.list(p, ps, { ventanaId, search });
    const totalPages = Math.ceil(total / ps);

    return {
      data,
      meta: { total, page: p, pageSize: ps, totalPages, hasNextPage: p < totalPages, hasPrevPage: p > 1 },
    };
  },

  async findById(id: string, current: CurrentUser) {
    const user = await VendedorRepository.findById(id);
    if (!user || user.isDeleted || user.role !== Role.VENDEDOR) throw new AppError("Vendedor no encontrado", 404);

    if (current.role === Role.ADMIN) return user;
    if (current.role === Role.VENTANA && current.ventanaId === user.ventanaId) return user;
    if (current.role === Role.VENDEDOR && current.id === id) return user;

    throw new AppError("Forbidden", 403);
  },
};
