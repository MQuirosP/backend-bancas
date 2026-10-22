import { ActivityType, Prisma, Role, SorteoStatus } from "../../../generated/prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import logger from "../../../core/logger";
import ActivityService from "../../../core/activity.service";
import SorteoRepository from "../../../repositories/sorteo.repository";
import { CacheService } from "../../../core/cache.service";
import { SocketService } from "../../../core/socket.service";
import { formatDateCRWithTZ } from "../../../utils/datetime";
import { SorteoCrudService } from "../crud/sorteo-crud.service";
import { serializeSorteo, UpdateSorteoDTO } from "../types/sorteo.types";

export class SorteoLifecycleService {
  /**
   * Activa o desactiva un sorteo
   */
  static async setActive(id: string, isActive: boolean, userId: string, bancaId?: string, role?: Role) {
    const existing = await SorteoCrudService.validateSorteoOwnership(id, bancaId, role);

    if (bancaId && !existing.bancaId && role !== Role.ADMIN) {
      throw new AppError("No tiene permisos para modificar un sorteo global", 403);
    }

    const s = await SorteoRepository.update(id, {
      isActive,
    } as UpdateSorteoDTO);

    const { clearSorteoCache } = require("../../../utils/sorteoCache");
    clearSorteoCache();
    CacheService.invalidateTag("sorteos").catch(() => { });
    CacheService.invalidateTag(`sorteo:${id}`).catch(() => { });
    SocketService.notifySorteosUpdated({ bancaId: existing.bancaId, action: "activated", sorteoId: id });

    const sFormattedAt = formatDateCRWithTZ(existing.scheduledAt);
    const lotName = existing.loteria?.name || "Lotería";
    const sorteoDesc = `${existing.name || "Sorteo"} (${lotName}) del ${sFormattedAt}`;

    await ActivityService.log({
      userId,
      bancaId: existing.bancaId,
      action: ActivityType.SORTEO_UPDATE,
      targetType: "SORTEO",
      targetId: id,
      details: {
        isActive,
        previousIsActive: existing.isActive,
        description: `Sorteo ${sorteoDesc} marcado como ${isActive ? "ACTIVO" : "INACTIVO"}`,
      },
    });

    return serializeSorteo(s);
  }

  /**
   * Fuerza el cambio de estado a OPEN desde cualquier estado (excepto EVALUATED)
   */
  static async forceOpen(id: string, userId: string, bancaId?: string, role?: Role) {
    const existing = await SorteoCrudService.validateSorteoOwnership(id, bancaId, role);

    if (bancaId && !existing.bancaId && role !== Role.ADMIN) {
      throw new AppError("No tiene permisos para modificar un sorteo global", 403);
    }
    if (existing.status === SorteoStatus.EVALUATED) {
      throw new AppError("No se puede reabrir un sorteo evaluado. Usa revert-evaluation primero.", 409);
    }

    const s = await SorteoRepository.forceOpen(id);

    const { clearSorteoCache } = require("../../../utils/sorteoCache");
    clearSorteoCache();
    CacheService.invalidateTag("sorteos").catch(() => { });
    CacheService.invalidateTag(`sorteo:${id}`).catch(() => { });
    SocketService.notifySorteosUpdated({ bancaId: existing.bancaId, action: "status_changed", sorteoId: id });

    const sFormattedAt = formatDateCRWithTZ(existing.scheduledAt);
    const lotName = existing.loteria?.name || "Lotería";
    const sorteoDesc = `${existing.name || "Sorteo"} (${lotName}) del ${sFormattedAt}`;

    const details: Prisma.InputJsonObject = {
      from: existing.status,
      to: SorteoStatus.OPEN,
      forced: true,
      description: `Sorteo ${sorteoDesc} RE-ABIERTO forzadamente (Estado anterior: ${existing.status})`,
    };

    await ActivityService.log({
      userId,
      bancaId: existing.bancaId,
      action: ActivityType.SORTEO_OPEN,
      targetType: "SORTEO",
      targetId: id,
      details,
    });

    return serializeSorteo(s);
  }

  /**
   * Activa un sorteo y lo pone en estado OPEN en una sola operación
   */
  static async activateAndOpen(id: string, userId: string, bancaId?: string, role?: Role) {
    const existing = await SorteoCrudService.validateSorteoOwnership(id, bancaId, role);

    if (bancaId && !existing.bancaId && role !== Role.ADMIN) {
      throw new AppError("No tiene permisos para modificar un sorteo global", 403);
    }
    if (existing.status === SorteoStatus.EVALUATED) {
      throw new AppError("No se puede reabrir un sorteo evaluado. Usa revert-evaluation primero.", 409);
    }

    const s = await prisma.sorteo.update({
      where: { id },
      data: {
        isActive: true,
        status: SorteoStatus.OPEN,
      },
      include: {
        loteria: {
          select: {
            id: true,
            name: true,
            rulesJson: true,
          },
        },
        extraMultiplier: {
          select: { id: true, name: true, valueX: true },
        },
      },
    });

    const { clearSorteoCache } = require("../../../utils/sorteoCache");
    clearSorteoCache();
    CacheService.invalidateTag("sorteos").catch(() => { });
    CacheService.invalidateTag(`sorteo:${id}`).catch(() => { });
    SocketService.notifySorteosUpdated({ bancaId: existing.bancaId, action: "status_changed", sorteoId: id });

    const details: Prisma.InputJsonObject = {
      from: {
        status: existing.status,
        isActive: existing.isActive,
      },
      to: {
        status: SorteoStatus.OPEN,
        isActive: true,
      },
      forced: true,
    };

    const sFormattedAt = formatDateCRWithTZ(existing.scheduledAt);
    const lotName = existing.loteria?.name || "Lotería";
    const sorteoDesc = `${existing.name || "Sorteo"} (${lotName}) del ${sFormattedAt}`;

    await ActivityService.log({
      userId,
      bancaId: existing.bancaId,
      action: ActivityType.SORTEO_UPDATE,
      targetType: "SORTEO",
      targetId: id,
      details: {
        ...details,
        description: `Sorteo ${sorteoDesc} activado y abierto forzadamente`,
      },
    });

    logger.info({
      layer: "service",
      action: "SORTEO_ACTIVATE_AND_OPEN",
      userId,
      payload: {
        sorteoId: id,
        previousStatus: existing.status,
        previousIsActive: existing.isActive,
      },
    });

    return serializeSorteo(s);
  }

  /**
   * Resetea un sorteo a estado SCHEDULED y activo
   */
  static async resetToScheduled(id: string, userId: string, bancaId?: string, role?: Role) {
    const existing = await SorteoCrudService.validateSorteoOwnership(id, bancaId, role);

    if (bancaId && !existing.bancaId && role !== Role.ADMIN) {
      throw new AppError("No tiene permisos para modificar un sorteo global", 403);
    }

    const allowedStatuses = [
      SorteoStatus.SCHEDULED,
      SorteoStatus.OPEN,
      SorteoStatus.CLOSED,
      SorteoStatus.EVALUATED,
    ];

    if (!allowedStatuses.includes(existing.status)) {
      throw new AppError(
        `No se puede resetear a SCHEDULED desde estado ${existing.status}`,
        409,
      );
    }

    const s = await prisma.sorteo.update({
      where: { id },
      data: {
        status: SorteoStatus.SCHEDULED,
        isActive: true,
        deletedAt: null,
        deletedBy: null,
        deletedReason: null,
        deletedByCascade: false,
        deletedByCascadeFrom: null,
        deletedByCascadeId: null,
      },
      include: {
        loteria: {
          select: {
            id: true,
            name: true,
            rulesJson: true,
          },
        },
        extraMultiplier: {
          select: { id: true, name: true, valueX: true },
        },
      },
    });

    const { clearSorteoCache } = require("../../../utils/sorteoCache");
    clearSorteoCache();
    CacheService.invalidateTag("sorteos").catch(() => { });
    CacheService.invalidateTag(`sorteo:${id}`).catch(() => { });
    SocketService.notifySorteosUpdated({ bancaId: existing.bancaId, action: "status_changed", sorteoId: id });

    const sFormattedAt = formatDateCRWithTZ(s.scheduledAt);
    const lotName = s.loteria?.name || "Lotería";
    const sorteoDesc = `${s.name || "Sorteo"} (${lotName}) del ${sFormattedAt}`;

    await ActivityService.log({
      userId,
      bancaId: existing.bancaId,
      action: ActivityType.SORTEO_UPDATE,
      targetType: "SORTEO",
      targetId: id,
      details: {
        status: SorteoStatus.SCHEDULED,
        isActive: true,
        previousStatus: existing.status,
        previousIsActive: existing.isActive,
        description: `Sorteo ${sorteoDesc} reseteado a estado PROGRAMADO`,
      },
    });

    return serializeSorteo(s);
  }

  /**
   * Abre un sorteo desde SCHEDULED
   */
  static async open(id: string, userId: string, bancaId?: string, role?: Role) {
    const existing = await SorteoCrudService.validateSorteoOwnership(id, bancaId, role);

    if (bancaId && !existing.bancaId && role !== Role.ADMIN) {
      throw new AppError("No tiene permisos para modificar un sorteo global", 403);
    }
    if (existing.status !== SorteoStatus.SCHEDULED) {
      throw new AppError("Solo se puede abrir desde SCHEDULED", 409);
    }
    if (!existing.isActive) {
      throw new AppError("No se puede abrir un sorteo inactivo", 409);
    }

    const s = await SorteoRepository.open(id);

    const { clearSorteoCache } = require("../../../utils/sorteoCache");
    clearSorteoCache();
    CacheService.invalidateTag("sorteos").catch(() => { });
    CacheService.invalidateTag(`sorteo:${id}`).catch(() => { });

    const sFormattedAt = formatDateCRWithTZ(existing.scheduledAt);
    const lotName = existing.loteria?.name || "Lotería";
    const sorteoDesc = `${existing.name || "Sorteo"} (${lotName}) del ${sFormattedAt}`;

    const details: Prisma.InputJsonObject = {
      from: existing.status,
      to: SorteoStatus.OPEN,
      description: `Sorteo ${sorteoDesc} ABIERTO`,
    };

    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_OPEN,
      targetType: "SORTEO",
      targetId: id,
      details,
    });

    return serializeSorteo(s);
  }

  /**
   * Cierra un sorteo desde OPEN o EVALUATED
   */
  static async close(id: string, userId: string, bancaId?: string, role?: Role) {
    const existing = await SorteoCrudService.validateSorteoOwnership(id, bancaId, role);

    if (bancaId && !existing.bancaId && role !== Role.ADMIN) {
      throw new AppError("No tiene permisos para modificar un sorteo global", 403);
    }
    if (existing.status !== SorteoStatus.OPEN && existing.status !== SorteoStatus.EVALUATED) {
      throw new AppError("Solo se puede cerrar desde OPEN o EVALUATED", 409);
    }

    const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - existing.scheduledAt.getTime() > maxAgeMs) {
      throw new AppError("No se puede cerrar un sorteo con más de 7 días de antigüedad. Contacte a soporte técnico.", 409);
    }

    const { sorteo: s, ticketsAffected } = await SorteoRepository.closeWithCascade(id);

    const { clearSorteoCache } = require("../../../utils/sorteoCache");
    clearSorteoCache();
    CacheService.invalidateTag("sorteos").catch(() => { });
    CacheService.invalidateTag(`sorteo:${id}`).catch(() => { });

    const sFormattedAt = formatDateCRWithTZ(existing.scheduledAt);
    const lotName = existing.loteria?.name || "Lotería";
    const sorteoDesc = `${existing.name || "Sorteo"} (${lotName}) del ${sFormattedAt}`;

    const details: Prisma.InputJsonObject = {
      from: existing.status,
      to: SorteoStatus.CLOSED,
      ticketsClosed: ticketsAffected,
      description: `Sorteo ${sorteoDesc} CERRADO (${ticketsAffected} tickets afectados)`,
    };

    await ActivityService.log({
      userId,
      bancaId: existing.bancaId,
      action: ActivityType.SORTEO_CLOSE,
      targetType: "SORTEO",
      targetId: id,
      details,
    });

    return serializeSorteo(s);
  }
}
