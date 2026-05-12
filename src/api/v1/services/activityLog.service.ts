import ActivityLogRepository from '../../../repositories/activityLog.repository';
import { ListActivityLogsQuery } from '../dto/activityLog.dto';
import { AppError } from '../../../core/errors';
import { ActivityType } from '@prisma/client';

export const ActivityLogService = {
  async getById(id: string, bancaId?: string | null) {
    const log = await ActivityLogRepository.getById(id);
    if (!log) {
      throw new AppError('Registro de auditoría no encontrado', 404);
    }

    // Seguridad: Si hay bancaId, validar que el log pertenece a esa banca
    if (bancaId && log.bancaId !== bancaId) {
      throw new AppError('No tiene permiso para ver este registro', 403);
    }

    return log;
  },

  async list(params: ListActivityLogsQuery, bancaId?: string | null) {
    const {
      page = 1,
      pageSize = 10,
      userId,
      action,
      targetType,
      targetId,
      startDate,
      endDate,
      search,
    } = params;

    // Validar rango de fechas
    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      if (start > end) {
        throw new AppError(
          'La fecha de inicio no puede ser mayor que la fecha de fin',
          400
        );
      }
    }

    const { data, total } = await ActivityLogRepository.list({
      page,
      pageSize,
      userId,
      action,
      targetType,
      targetId,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      search,
      bancaId, // Pasar bancaId al repositorio (que ahora maneja string | null)
    });

    const totalPages = Math.ceil(total / pageSize);

    return {
      data,
      meta: {
        total,
        page,
        pageSize,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  },

  async getByUser(userId: string, page = 1, pageSize = 20, bancaId?: string | null) {
    const { data, total } = await ActivityLogRepository.listByUser(userId, page, pageSize, bancaId);
    const totalPages = Math.ceil(total / pageSize);
    return {
      data,
      meta: {
        total,
        page,
        pageSize,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  },

  async getByTarget(targetType: string, targetId: string, page = 1, pageSize = 20, bancaId?: string | null) {
    const { data, total } = await ActivityLogRepository.listByTarget(targetType, targetId, page, pageSize, bancaId);
    const totalPages = Math.ceil(total / pageSize);
    return {
      data,
      meta: {
        total,
        page,
        pageSize,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  },

  async getByAction(action: ActivityType, page = 1, pageSize = 20, bancaId?: string | null) {
    const { data, total } = await ActivityLogRepository.listByAction(action, page, pageSize, bancaId);
    const totalPages = Math.ceil(total / pageSize);
    return {
      data,
      meta: {
        total,
        page,
        pageSize,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  },

  async cleanupOldLogs(days: number = 45, bancaId?: string | null) {
    if (days < 1) {
      throw new AppError('El número de días debe ser mayor a 0', 400);
    }
    const result = await ActivityLogRepository.deleteOlderThan(days, bancaId);
    return {
      message: `Se eliminaron ${result.count} registros de auditoría`,
      deletedCount: result.count,
    };
  },
};

export default ActivityLogService;
