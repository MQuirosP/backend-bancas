import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import ActivityService from "../../../core/activity.service";
import BancaRepository from "../../../repositories/banca.repository";
import { ActivityType, Role } from "@prisma/client";
import { CreateBancaInput, UpdateBancaInput } from "../dto/banca.dto";
import { LoteriaService } from "./loteria.service";
import { hashPassword } from "../../../utils/crypto";
import { CacheService } from "../../../core/cache.service";

export const BancaService = {
  async create(data: CreateBancaInput, userId: string) {
    // 1. Validaciones previas de unicidad
    if (await BancaRepository.findByCode(data.code)) throw new AppError("El código de la banca ya existe", 400);
    if (await BancaRepository.findByName(data.name)) throw new AppError("El nombre de la banca ya existe", 400);

    if (data.username) {
      const existingUser = await prisma.user.findUnique({ where: { username: data.username } });
      if (existingUser) throw new AppError(`El nombre de usuario "${data.username}" ya está en uso`, 400);
    }

    console.log(`[BancaService] Creando banca: ${data.name}, importBaseLoterias: ${data.importBaseLoterias}`);

    // 2. Ejecutar creación en transacción para asegurar consistencia
    const result = await prisma.$transaction(async (tx) => {
      // A. Crear la Banca
      const banca = await tx.banca.create({
        data: {
          name: data.name,
          code: data.code,
          email: data.email,
          address: data.address,
          phone: data.phone,
          isActive: data.isActive ?? true,
          defaultMinBet: data.defaultMinBet ?? 100,
          globalMaxPerNumber: data.globalMaxPerNumber ?? 5000,
          salesCutoffMinutes: data.salesCutoffMinutes ?? 1,
          vendorLimit: data.vendorLimit,
          // Si hay cutoff, crear la regla inicial (esto replica la lógica del repositorio)
          ...(data.salesCutoffMinutes ? {
            restrictionRules: {
              create: [{ salesCutoffMinutes: Math.trunc(data.salesCutoffMinutes) }]
            }
          } : {})
        }
      });

      // B. Si hay datos de usuario, crearlo vinculado a la banca
      if (data.username && data.password) {
        const hashedPassword = await hashPassword(data.password);
        const newUser = await tx.user.create({
          data: {
            username: data.username,
            password: hashedPassword,
            name: `Admin ${data.name}`,
            role: Role.BANCA,
            bancaId: banca.id,
          }
        });

        // C. Crear vínculo en UserBanca para que aparezca en su listado
        await tx.userBanca.create({
          data: {
            userId: newUser.id,
            bancaId: banca.id,
            isDefault: true
          }
        });
      }

      return banca;
    });

    const banca = result;

    await ActivityService.log({
      userId,
      action: ActivityType.BANCA_CREATE,
      targetType: "BANCA",
      targetId: banca.id,
      details: {
        ...data,
        password: '***',
        confirmPassword: '***',
        description: `Banca creada con administrador: ${banca.name} (${banca.code})`
      },
    });

    // 3. Importación opcional de loterías base (Worker asíncrono)
    if (data.importBaseLoterias) {
      LoteriaService.cloneGlobalToBanca(banca.id, userId).catch(err => {
        console.error(`[BancaService] Error in background lottery cloning: ${err.message}`);
      });
    }

    return banca;
  },

  async update(id: string, data: UpdateBancaInput, userId: string) {
    const existing = await BancaRepository.findById(id);
    if (!existing || !existing.isActive) throw new AppError("Banca no encontrada o inactiva", 404);

    if (data.code && data.code !== existing.code) {
      const dup = await BancaRepository.findByCode(data.code);
      if (dup) throw new AppError("El código de la banca ya existe", 400);
    }
    if (data.name && data.name !== existing.name) {
      const dupN = await BancaRepository.findByName(data.name);
      if (dupN) throw new AppError("El nombre de la banca ya existe", 400);
    }

    const banca = await BancaRepository.update(id, data);

    // Logout masivo: solo si vendorLimit disminuye
    const vendorLimitReduced =
      data.vendorLimit !== undefined &&
      existing.vendorLimit !== null &&
      data.vendorLimit < existing.vendorLimit;

    if (vendorLimitReduced) {
      // Revocar SOLO sesiones de VENDEDOR de ESTA banca
      const revoked = await prisma.refreshToken.updateMany({
        where: {
          revoked: false,
          user: {
            bancaId: id,         // acotado al tenant que cambió
            role: Role.VENDEDOR, // solo VENDEDOR
          },
        },
        data: {
          revoked: true,
          revokedAt: new Date(),
          revokedReason: 'vendor_limit_reduced',
        },
      });

      console.log(`[BancaService] VENDOR_LIMIT_REDUCED_LOGOUT: bancaId=${id}, revokedSessions=${revoked.count}`);
    }

    await CacheService.invalidateTag(`banca:${id}`);

    await ActivityService.log({
      userId,
      action: ActivityType.BANCA_UPDATE,
      targetType: "BANCA",
      targetId: id,
      details: {
        ...data,
        ...(vendorLimitReduced ? { vendorLimitReducedFrom: existing.vendorLimit } : {}),
        description: `Banca actualizada: ${banca.name} (${banca.code})`
      },
    });

    return banca;
  },

  async softDelete(id: string, userId: string, reason?: string) {
    // Política operativa: desactivar si no hay Ventanas activas
    const activeVentanas = await prisma.ventana.count({ where: { bancaId: id, isActive: true } });
    if (activeVentanas > 0) {
      throw new AppError("No se puede desactivar la banca: existen Ventanas activas asociadas.", 409);
    }

    const banca = await BancaRepository.softDelete(id, userId, reason);
    await CacheService.invalidateTag(`banca:${id}`);

    await ActivityService.log({
      userId,
      action: ActivityType.BANCA_DELETE,
      targetType: "BANCA",
      targetId: id,
      details: {
        reason,
        description: `Banca desactivada: ${banca.name} (${banca.code}). Razón: ${reason ?? 'No especificada'}`
      },
    });

    return banca;
  },

  async findAll(page?: number, pageSize?: number, search?: string, isActive?: boolean, userId?: string, userRole?: string) {
    const p = page && page > 0 ? page : 1;
    const ps = pageSize && pageSize > 0 ? pageSize : 10;

    let allowedBancaIds: string[] | undefined = undefined;

    //  NUEVO: Aislamiento para rol BANCA
    if (userRole === Role.BANCA && userId) {
      const userBancas = await prisma.userBanca.findMany({
        where: { userId },
        select: { bancaId: true },
      });
      allowedBancaIds = userBancas.map(ub => ub.bancaId);

      // Si no tiene bancas asignadas, devolver lista vacía
      if (allowedBancaIds.length === 0) {
        return {
          data: [],
          meta: {
            total: 0,
            page: p,
            pageSize: ps,
            totalPages: 0,
            hasNextPage: false,
            hasPrevPage: false,
          },
        };
      }
    }

    // ADMIN ve todas las bancas (allowedBancaIds = undefined)
    // VENTANA/VENDEDOR: En teoría no deberían usar este endpoint global, 
    // pero si lo hacen, allowedBancaIds seguirá siendo undefined a menos que implementemos más filtros.
    // Sin embargo, el Repositorio ya maneja allowedBancaIds si se pasa.
    const { data, total } = await BancaRepository.list(p, ps, search, isActive, allowedBancaIds);
    const totalPages = Math.ceil(total / ps);

    return {
      data,
      meta: {
        total,
        page: p,
        pageSize: ps,
        totalPages,
        hasNextPage: p < totalPages,
        hasPrevPage: p > 1,
      },
    };
  },

  async findById(id: string, userId?: string, userRole?: string) {
    const banca = await BancaRepository.findById(id);
    if (!banca || !banca.isActive) throw new AppError("Banca no encontrada o inactiva", 404);

    //  NUEVO: Validar acceso para rol BANCA
    if (userRole === Role.BANCA && userId) {
      const assignment = await prisma.userBanca.findFirst({
        where: { userId, bancaId: id },
      });
      if (!assignment) {
        throw new AppError("No tienes permiso para acceder a esta banca", 403, "FORBIDDEN");
      }
    }

    return banca;
  },

  async restore(id: string, userId: string, reason?: string) {
    const banca = await BancaRepository.restore(id);

    await ActivityService.log({
      userId,
      action: ActivityType.BANCA_RESTORE,
      targetType: "BANCA",
      targetId: id,
      details: {
        reason,
        description: `Banca restaurada: ${banca.name} (${banca.code}). Razón: ${reason ?? 'No especificada'}`
      },
    });

    return banca;
  },
};
