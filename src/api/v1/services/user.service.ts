import prisma from '../../../core/prismaClient';
import { AppError } from '../../../core/errors';
import { CreateUserDTO, UpdateUserDTO } from '../dto/user.dto';
import { hashPassword, comparePassword } from '../../../utils/crypto';
import UserRepository from '../../../repositories/user.repository';
import { Role, ActivityType } from '@prisma/client';
import { normalizePhone } from "../../../utils/phoneNormalizer";
import ActivityService from '../../../core/activity.service';
import { parseCommissionPolicy, CommissionRule } from '../../../services/commission.resolver';

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

async function ensureVentanaActiveOrThrow(ventanaId: string) {
  const v = await prisma.ventana.findUnique({
    where: { id: ventanaId },
    select: { id: true, isActive: true, banca: { select: { id: true, isActive: true } } },
  });
  if (!v || !v.isActive) throw new AppError('Ventana not found or inactive', 404);
  if (!v.banca || !v.banca.isActive) throw new AppError('Parent Banca inactive', 409);
}

async function getActorVentanaId(actorId: string) {
  const actor = await prisma.user.findUnique({
    where: { id: actorId },
    select: { ventanaId: true },
  });
  if (!actor || !actor.ventanaId) {
    throw new AppError('No tienes una ventana asignada', 403);
  }
  return actor.ventanaId;
}

export const UserService = {
  async create(dto: CreateUserDTO, actor?: { id: string; role: Role }) {
    const actingRole = actor?.role ?? Role.ADMIN;
    const actorId = actor?.id;
    let enforcedVentanaId: string | null = null;

    if (actingRole === Role.VENTANA) {
      if (dto.role && dto.role !== Role.VENDEDOR) {
        throw new AppError('Solo puedes crear usuarios vendedores', 403);
      }
      const forbiddenFields = ['isActive', 'code', 'role', 'ventanaId'] as const;
      for (const field of forbiddenFields) {
        if ((dto as any)[field] !== undefined) {
          throw new AppError(`Campo no permitido para VENTANA: ${field}`, 403);
        }
      }
      if (!actorId) {
        throw new AppError('No autenticado', 401);
      }
      enforcedVentanaId = await getActorVentanaId(actorId);
      await ensureVentanaActiveOrThrow(enforcedVentanaId);
      dto = {
        name: dto.name,
        email: dto.email ?? undefined,
        phone: dto.phone ?? undefined,
        username: dto.username,
        password: dto.password,
        role: Role.VENDEDOR,
        ventanaId: enforcedVentanaId,
      } as CreateUserDTO;
    }

    const username = dto.username.trim();
    const role: Role = actingRole === Role.VENTANA ? Role.VENDEDOR : ((dto.role as Role) ?? Role.VENTANA);
    const email = dto.email ? dto.email.trim().toLowerCase() : null;
    const code = dto.code?.trim() ? dto.code.trim() : null;
    const phone = dto.phone !== undefined ? normalizePhone(dto.phone) : null;
    const isActive = dto.isActive ?? true;

    // Regla role  ventanaId
    if (role === Role.ADMIN) {
      dto.ventanaId = null as any;
    } else {
      if (!dto.ventanaId) throw new AppError('ventanaId is required for role ' + role, 400);
      await ensureVentanaActiveOrThrow(dto.ventanaId);
    }

    // Unicidad username
    const userByUsername = await prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (userByUsername) throw new AppError('Username already in use', 409);

    // Unicidad email (si viene)
    if (email) {
      const userByEmail = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (userByEmail) throw new AppError('Email already in use', 409);
    }

    // Unicidad code (si viene) – Prisma ya es unique, pero damos error claro
    if (code) {
      const userByCode = await prisma.user.findFirst({ where: { code }, select: { id: true } });
      if (userByCode) throw new AppError('Code already in use', 409);
    }

    const hashed = await hashPassword(dto.password);

    const created = await UserRepository.create({
      name: dto.name,
      email,
      username,
      phone,
      password: hashed,
      role,
      ventanaId: role === Role.ADMIN ? null : (enforcedVentanaId ?? dto.ventanaId!),
      code,                 
      isActive: actingRole === Role.VENTANA ? true : isActive,             
    });

    const result = await prisma.user.findUnique({
      where: { id: created.id },
      select: {
        id: true, name: true, username: true, email: true, role: true,
        ventanaId: true, isActive: true, code: true,
        createdAt: true, settings: true, platform: true, appVersion: true,
      },
    });

    // Log de auditoría
    if (result && actorId) {
      await ActivityService.log({
        userId: actorId,
        action: ActivityType.USER_CREATE,
        targetType: 'USER',
        targetId: result.id,
        details: { username: result.username, role: result.role, ventanaId: result.ventanaId },
      });
    }

    return result!;
  },

  async getById(id: string) {
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true, name: true, email: true, username: true, role: true,
        ventanaId: true, isActive: true, code: true,
        createdAt: true, settings: true, platform: true, appVersion: true,
      },
    });
    if (!user) throw new AppError('User not found', 404);
    return user;
  },

  async list(params: {
    page?: number;
    pageSize?: number;
    role?: string;
    search?: string;
    ventanaId?: string;
    isActive?: boolean;
  }) {
    const page = params.page && params.page > 0 ? params.page : 1;
    const pageSize = params.pageSize && params.pageSize > 0 ? params.pageSize : 10;

    const { data, total } = await UserRepository.listPaged({
      page,
      pageSize,
      role: params.role as Role | undefined,
      search: params.search?.trim() || undefined,
      ventanaId: params.ventanaId,
      isActive: params.isActive,
    });

    const totalPages = Math.ceil(total / pageSize);
    return {
      data,
      meta: { total, page, pageSize, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 },
    };
  },

  async update(id: string, dto: UpdateUserDTO, actor?: { id: string; role: Role }) {
    const actingRole = actor?.role ?? Role.ADMIN;
    const actorId = actor?.id;
    let actorVentanaId: string | null = null;
    const editingSelf = actorId === id;

    // Cargar actual para comparaciones
    const current = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true, username: true, email: true, role: true, ventanaId: true, code: true,
      },
    });
    if (!current) throw new AppError('User not found', 404);

    if (actingRole === Role.VENTANA) {
      if (!actorId) throw new AppError('No autenticado', 401);
      actorVentanaId = await getActorVentanaId(actorId);
      if (!editingSelf && current.ventanaId !== actorVentanaId) {
        throw new AppError('No puedes modificar usuarios de otra ventana', 403);
      }
      //  VENTANA puede actualizar settings (para configurar impresora, tema, etc.)
      const forbiddenForVentana: Array<keyof UpdateUserDTO> = ['role', 'ventanaId', 'code'];
      for (const field of forbiddenForVentana) {
        if ((dto as any)[field] !== undefined) {
          throw new AppError(`Campo no permitido para VENTANA: ${field}`, 403);
        }
      }
    }

    const toUpdate: any = {};

    // username (unicidad si cambia)
    if (dto.username && dto.username.trim() !== current.username) {
      const newUsername = dto.username.trim();
      const dup = await prisma.user.findUnique({ where: { username: newUsername }, select: { id: true } });
      if (dup && dup.id !== id) throw new AppError('Username already in use', 409);
      toUpdate.username = newUsername;
    }

    // email (normalización + unicidad si cambia)
    if (dto.email !== undefined) {
      const e = dto.email === null ? null : dto.email.trim().toLowerCase();
      if (e !== current.email) {
        if (e) {
          const dupEmail = await prisma.user.findUnique({ where: { email: e }, select: { id: true } });
          if (dupEmail && dupEmail.id !== id) throw new AppError('Email already in use', 409);
        }
        toUpdate.email = e;
      }
    }

    // name
    if (dto.name !== undefined) toUpdate.name = dto.name;

    // password
    if (dto.password) {
      toUpdate.password = await hashPassword(dto.password);
    }

    // role  ventanaId
    if (dto.role) {
      if (actingRole === Role.VENTANA) {
        throw new AppError('No puedes cambiar el rol', 403);
      }
      const newRole = dto.role as Role;
      toUpdate.role = newRole;

      if (newRole === Role.ADMIN) {
        // Forzar desvinculación
        toUpdate.ventanaId = null;
      } else {
        // Requiere ventanaId (nuevo o conservar el actual)
        const effectiveVentanaId = dto.ventanaId ?? current.ventanaId;
        if (!effectiveVentanaId) throw new AppError('ventanaId is required for role ' + newRole, 400);
        await ensureVentanaActiveOrThrow(effectiveVentanaId);
        toUpdate.ventanaId = effectiveVentanaId;
      }
    } else if (dto.ventanaId !== undefined) {
      if (actingRole === Role.VENTANA) {
        throw new AppError('No puedes cambiar la ventana asociada', 403);
      }
      // Cambian solo ventanaId (sin cambiar role): validar si el role actual lo requiere
      if (current.role === Role.ADMIN) {
        // Admin no debería estar ligado a ventana
        toUpdate.ventanaId = null;
      } else {
        if (!dto.ventanaId) throw new AppError('ventanaId is required for role ' + current.role, 400);
        await ensureVentanaActiveOrThrow(dto.ventanaId);
        toUpdate.ventanaId = dto.ventanaId;
      }
    }

    // toggle de actividad (deprecated isDeleted → usar isActive inverso)
    if (dto.isActive !== undefined) {
      if (actingRole === Role.VENTANA && !editingSelf) {
        toUpdate.isActive = dto.isActive;
      } else if (actingRole !== Role.VENTANA) {
        toUpdate.isActive = dto.isActive;
      } else if (actingRole === Role.VENTANA && editingSelf) {
        throw new AppError('No puedes modificar tu propio estado', 403);
      }
    }

    //  settings: merge parcial con los settings existentes
    // VENTANA puede modificar settings de usuarios de su ventana (validación de ventana ya aplicada arriba)
    if (dto.settings !== undefined) {
      // Obtener settings actuales (pueden ser null)
      const currentUser = await prisma.user.findUnique({
        where: { id },
        select: { settings: true },
      });

      const currentSettings = currentUser?.settings as Record<string, any> | null || {};

      if (dto.settings === null) {
        // Si envían null explícitamente, limpiar settings
        toUpdate.settings = null;
      } else {
        // Merge parcial: el DTO override los campos que vienen, mantienen los demás
        const mergedSettings = deepMergeSettings(currentSettings, dto.settings);
        toUpdate.settings = mergedSettings;
      }
    }

    const updated = await UserRepository.update(id, toUpdate);

    // Respuesta coherente (incluye username)
    const result = await prisma.user.findUnique({
      where: { id: updated.id },
      select: {
        id: true, name: true, username: true, email: true, role: true,
        ventanaId: true, isActive: true, createdAt: true, settings: true,
        platform: true, appVersion: true,
      },
    });

    // Log de auditoría
    if (result && actorId && Object.keys(toUpdate).length > 0) {
      await ActivityService.log({
        userId: actorId,
        action: ActivityType.USER_UPDATE,
        targetType: 'USER',
        targetId: id,
        details: { changedFields: Object.keys(toUpdate) },
      });
    }

    return result!;
  },

  async softDelete(
    id: string,
    actor?: { id: string; role: Role },
    deletedBy?: string,
    deletedReason?: string
  ) {
    const actingRole = actor?.role ?? Role.ADMIN;
    const actorId = deletedBy ?? actor?.id;

    const current = await prisma.user.findUnique({
      where: { id },
      select: { ventanaId: true },
    });
    if (!current) throw new AppError('User not found', 404);

    if (actingRole === Role.VENTANA) {
      if (!actorId) throw new AppError('No autenticado', 401);
      const actorVentanaId = await getActorVentanaId(actorId);
      if (current.ventanaId !== actorVentanaId) {
        throw new AppError('No puedes eliminar usuarios de otra ventana', 403);
      }
    }

    const user = await prisma.user.update({
      where: { id },
      data: {
        isActive: false,
      },
      select: { id: true, name: true, email: true, role: true, ventanaId: true, isActive: true, createdAt: true },
    });

    // Log de auditoría
    if (actorId) {
      await ActivityService.log({
        userId: actorId,
        action: ActivityType.USER_DELETE,
        targetType: 'USER',
        targetId: id,
        details: { reason: deletedReason },
      });
    }

    return user;
  },

  async getAllowedMultipliers(
    userId: string,
    loteriaId: string,
    betType: 'NUMERO' | 'REVENTADO' = 'NUMERO'
  ) {
    // Optimización: Hacer todas las queries en paralelo
    const [user, loteria, activeMultipliers] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          role: true,
          commissionPolicyJson: true,
        },
      }),
      prisma.loteria.findUnique({
        where: { id: loteriaId },
        select: { id: true, isActive: true },
      }),
      prisma.loteriaMultiplier.findMany({
        where: {
          loteriaId,
          isActive: true,
          kind: betType,
        },
        select: {
          id: true,
          loteriaId: true,
          name: true,
          valueX: true,
          kind: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    // Validaciones
    if (!user) {
      throw new AppError('Usuario no encontrado', 404, { code: 'USER_NOT_FOUND' });
    }

    if (user.role !== Role.VENDEDOR) {
      throw new AppError('El usuario debe tener rol VENDEDOR', 400, {
        code: 'INVALID_USER_ROLE',
        details: [{ field: 'userId', message: 'El usuario debe ser un vendedor' }],
      });
    }

    if (!loteria) {
      throw new AppError('Lotería no encontrada', 404, { code: 'LOTERIA_NOT_FOUND' });
    }

    const totalActiveMultipliers = activeMultipliers.length;

    // Obtener política de comisión del vendedor
    const policyJson = user.commissionPolicyJson;
    const policyExists = !!policyJson;

    // Si no hay política, retornar vacío
    if (!policyJson) {
      return {
        data: [],
        meta: {
          policyExists: false,
          policyEffective: false,
          rulesMatched: 0,
          totalActiveMultipliers,
        },
      };
    }

    // Parsear política usando la función existente
    const policy = parseCommissionPolicy(policyJson, 'USER');

    // Si la política no es válida o no tiene reglas, retornar vacío
    if (!policy || !policy.rules || policy.rules.length === 0) {
      return {
        data: [],
        meta: {
          policyExists: true,
          policyEffective: false,
          rulesMatched: 0,
          totalActiveMultipliers,
        },
      };
    }

    // Verificar vigencia temporal
    const now = new Date();
    const effectiveFrom = policy.effectiveFrom ? new Date(policy.effectiveFrom) : null;
    const effectiveTo = policy.effectiveTo ? new Date(policy.effectiveTo) : null;

    const policyEffective =
      (!effectiveFrom || now >= effectiveFrom) && (!effectiveTo || now <= effectiveTo);

    if (!policyEffective) {
      return {
        data: [],
        meta: {
          policyExists: true,
          policyEffective: false,
          rulesMatched: 0,
          totalActiveMultipliers,
        },
      };
    }

    // Pre-filtrar reglas aplicables para optimizar
    const applicableRules = policy.rules.filter((rule: CommissionRule) => {
      const loteriaMatches = rule.loteriaId === null || rule.loteriaId === loteriaId;
      const betTypeMatches = rule.betType === null || rule.betType === betType;
      return loteriaMatches && betTypeMatches && !!rule.multiplierRange;
    });

    if (applicableRules.length === 0) {
      return {
        data: [],
        meta: {
          policyExists: true,
          policyEffective: true,
          rulesMatched: 0,
          totalActiveMultipliers,
        },
      };
    }

    // Filtrar multiplicadores según reglas de la política (optimizado)
    const allowedMultiplierIds = new Set<string>();
    const matchedRuleIds = new Set<string>();

    for (const multiplier of activeMultipliers) {
      for (const rule of applicableRules) {
        const multiplierInRange =
          multiplier.valueX >= rule.multiplierRange!.min &&
          multiplier.valueX <= rule.multiplierRange!.max;

        if (multiplierInRange) {
          allowedMultiplierIds.add(multiplier.id);
          matchedRuleIds.add(rule.id);
          break; // Primera regla que aplica gana
        }
      }
    }

    // Obtener multiplicadores permitidos (mantener orden original)
    const allowedMultipliers = activeMultipliers.filter((m) => allowedMultiplierIds.has(m.id));

    return {
      data: allowedMultipliers,
      meta: {
        policyExists: true,
        policyEffective: true,
        rulesMatched: matchedRuleIds.size,
        totalActiveMultipliers,
      },
    };
  },

  async restore(id: string, actor?: { id: string; role: Role }) {
    const actingRole = actor?.role ?? Role.ADMIN;
    const actorId = actor?.id;

    const current = await prisma.user.findUnique({
      where: { id },
      select: { ventanaId: true },
    });
    if (!current) throw new AppError('User not found', 404);

    if (actingRole === Role.VENTANA) {
      if (!actorId) throw new AppError('No autenticado', 401);
      const actorVentanaId = await getActorVentanaId(actorId);
      if (current.ventanaId !== actorVentanaId) {
        throw new AppError('No puedes restaurar usuarios de otra ventana', 403);
      }
    }

    const user = await prisma.user.update({
      where: { id },
      data: { isActive: true },
      select: { id: true, name: true, email: true, role: true, ventanaId: true, isActive: true, createdAt: true },
    });

    // Log de auditoría
    if (actorId) {
      await ActivityService.log({
        userId: actorId,
        action: ActivityType.USER_RESTORE,
        targetType: 'USER',
        targetId: id,
        details: null,
      });
    }

    return user;
  },

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    // Obtener contraseña actual del usuario
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true, name: true },
    });

    if (!user) {
      throw new AppError('Usuario no encontrado', 404, { code: 'USER_NOT_FOUND' });
    }

    // Verificar que la contraseña actual es correcta
    const isPasswordValid = await comparePassword(currentPassword, user.password);
    if (!isPasswordValid) {
      throw new AppError('Contraseña actual incorrecta', 400, { code: 'INVALID_PASSWORD' });
    }

    // Hash de la nueva contraseña
    const hashedNewPassword = await hashPassword(newPassword);

    // Actualizar contraseña
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedNewPassword },
    });

    return {
      success: true,
      message: 'Contraseña actualizada correctamente',
    };
  },
};

export default UserService;
