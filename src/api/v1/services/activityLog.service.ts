import ActivityLogRepository from '../../../repositories/activityLog.repository';
import { ListActivityLogsQuery } from '../dto/activityLog.dto';
import { AppError } from '../../../core/errors';
import { ActivityType } from '@prisma/client';

export const ActivityLogService = {
  async getById(id: string) {
    const log = await ActivityLogRepository.getById(id);
    if (!log) {
      throw new AppError('Registro de auditoría no encontrado', 404);
    }
    return log;
  },

  async list(params: ListActivityLogsQuery) {
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

  async getByUser(userId: string, page = 1, pageSize = 20) {
    const { data, total } = await ActivityLogRepository.listByUser(userId, page, pageSize);
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

  async getByTarget(targetType: string, targetId: string, page = 1, pageSize = 20) {
    const { data, total } = await ActivityLogRepository.listByTarget(targetType, targetId, page, pageSize);
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

  async getByAction(action: ActivityType, page = 1, pageSize = 20) {
    const { data, total } = await ActivityLogRepository.listByAction(action, page, pageSize);
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

  async cleanupOldLogs(days: number = 45) {
    if (days < 1) {
      throw new AppError('El número de días debe ser mayor a 0', 400);
    }
    const result = await ActivityLogRepository.deleteOlderThan(days);
    return {
      message: `Se eliminaron ${result.count} registros de auditoría`,
      deletedCount: result.count,
    };
  },
};

export default ActivityLogService;
