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

  async getByUser(userId: string) {
    return ActivityLogRepository.listByUser(userId, 100);
  },

  async getByTarget(targetType: string, targetId: string) {
    return ActivityLogRepository.listByTarget(targetType, targetId);
  },

  async getByAction(action: ActivityType) {
    return ActivityLogRepository.listByAction(action, 100);
  },

  async cleanupOldLogs(days: number = 90) {
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
