import { ActivityType, Role } from "@prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import ActivityService from "../../../core/activity.service";
import VentanaRepository from "../../../repositories/ventana.repository";
import { CreateVentanaInput, UpdateVentanaInput } from "../dto/ventana.dto";
import { hashPassword } from "../../../utils/crypto";
import logger from "../../../core/logger";

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

    // Validar código único
    if (data.code) {
      const existing = await VentanaRepository.findByCode(data.code);
      if (existing) throw new AppError("El código de la ventana ya existe", 400);
    }

    // ✅ Validar username único antes de iniciar transacción
    const existingUser = await prisma.user.findUnique({
      where: { username: data.username.trim() },
      select: { id: true },
    });
    if (existingUser) {
      throw new AppError("El usuario ya existe", 409, "USERNAME_EXISTS");
    }

    // ✅ Crear ventana y usuario en la misma transacción
    const result = await prisma.$transaction(async (tx) => {
      // 1. Crear ventana
      const ventanaData = {
        bancaId: data.bancaId,
        name: data.name,
        code: data.code,
        commissionMarginX: data.commissionMarginX,
        address: data.address,
        phone: data.phone,
        email: data.email,
        isActive: data.isActive ?? true,
        settings: data.settings,
      };
      
      const ventana = await tx.ventana.create({
        data: {
          name: ventanaData.name,
          code: ventanaData.code ?? undefined,
          commissionMarginX: ventanaData.commissionMarginX ?? 0,
          address: ventanaData.address ?? null,
          phone: ventanaData.phone ?? null,
          email: ventanaData.email ?? null,
          isActive: ventanaData.isActive ?? true,
          settings: ventanaData.settings ? (ventanaData.settings as any) : undefined,
          banca: { connect: { id: ventanaData.bancaId } },
        },
      });

      // 2. Crear usuario asociado con rol VENTANA
      const hashedPassword = await hashPassword(data.password);
      const user = await tx.user.create({
        data: {
          name: ventana.name,
          username: data.username.trim(),
          email: ventana.email,
          password: hashedPassword,
          role: Role.VENTANA,
          ventanaId: ventana.id,
          isActive: ventana.isActive,
        },
      });

      logger.info({
        layer: "service",
        action: "VENTANA_USER_CREATE",
        userId,
        payload: {
          ventanaId: ventana.id,
          userId: user.id,
          username: user.username,
          message: "Ventana y usuario creados en transacción",
        },
      });

      return { ventana, user };
    });

    await ActivityService.log({
      userId,
      action: ActivityType.VENTANA_CREATE,
      targetType: "VENTANA",
      targetId: result.ventana.id,
      details: {
        ...data,
        password: undefined, // No guardar password en logs
        userCreated: true,
        userId: result.user.id,
      },
    });

    // ✅ Retornar ventana con metadata del usuario creado
    return {
      ...result.ventana,
      _meta: {
        userCreated: true,
        userId: result.user.id,
        username: result.user.username,
      },
    } as any;
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
    
    // ✅ Manejar actualización de usuario asociado
    let passwordToUpdate: string | undefined;
    let usernameToUpdate: string | undefined;
    if (data.password) {
      passwordToUpdate = data.password;
      delete toUpdate.password; // Remover de toUpdate ya que no es campo de Ventana
    }
    if (data.username) {
      usernameToUpdate = data.username.trim();
      delete toUpdate.username; // Remover de toUpdate ya que no es campo de Ventana
    }

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

    // ✅ Actualizar o crear usuario asociado a la ventana (rol VENTANA)
    if (passwordToUpdate || usernameToUpdate) {
      const ventanaUser = await prisma.user.findFirst({
        where: {
          ventanaId: id,
          role: Role.VENTANA,
        },
        select: { id: true, username: true },
      });

      if (ventanaUser) {
        // Actualizar usuario existente
        const updateData: any = {};
        
        if (passwordToUpdate) {
          updateData.password = await hashPassword(passwordToUpdate);
        }
        
        if (usernameToUpdate) {
          // Validar que el nuevo username no esté en uso
          const existingUsername = await prisma.user.findUnique({
            where: { username: usernameToUpdate },
            select: { id: true },
          });
          if (existingUsername && existingUsername.id !== ventanaUser.id) {
            throw new AppError("El usuario ya existe", 409, "USERNAME_EXISTS");
          }
          updateData.username = usernameToUpdate;
        }

        await prisma.user.update({
          where: { id: ventanaUser.id },
          data: updateData,
        });

        logger.info({
          layer: "service",
          action: "VENTANA_USER_UPDATE",
          userId,
          payload: {
            ventanaId: id,
            userId: ventanaUser.id,
            updatedFields: Object.keys(updateData),
            message: "Usuario VENTANA actualizado",
          },
        });
      } else {
        // Crear usuario si no existe y se envía password
        if (!passwordToUpdate) {
          throw new AppError("No se puede crear usuario sin contraseña. Proporcione 'password' en el request.", 400);
        }

        const finalUsername = usernameToUpdate || `${ventana.name.toLowerCase().replace(/\s+/g, '_')}_${ventana.code || ventana.id.slice(0, 8)}`;
        
        // Validar que el username generado no esté en uso
        const existingUsername = await prisma.user.findUnique({
          where: { username: finalUsername },
          select: { id: true },
        });
        if (existingUsername) {
          throw new AppError(`El usuario '${finalUsername}' ya existe. Proporcione un 'username' diferente.`, 409, "USERNAME_EXISTS");
        }

        const hashedPassword = await hashPassword(passwordToUpdate);
        const newUser = await prisma.user.create({
          data: {
            name: ventana.name,
            username: finalUsername,
            email: ventana.email,
            password: hashedPassword,
            role: Role.VENTANA,
            ventanaId: ventana.id,
            isActive: ventana.isActive,
          },
        });

        logger.info({
          layer: "service",
          action: "VENTANA_USER_CREATE_ON_UPDATE",
          userId,
          payload: {
            ventanaId: id,
            userId: newUser.id,
            username: newUser.username,
            message: "Usuario VENTANA creado automáticamente al actualizar ventana",
          },
        });
      }
    }

    await ActivityService.log({
      userId,
      action: ActivityType.VENTANA_UPDATE,
      targetType: "VENTANA",
      targetId: id,
      details: {
        ...data,
        passwordUpdated: passwordToUpdate ? true : undefined,
      },
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
