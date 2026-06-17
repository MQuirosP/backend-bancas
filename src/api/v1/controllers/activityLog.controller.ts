import { Response } from 'express';
import ActivityLogService from '../services/activityLog.service';
import { ListActivityLogsQuery } from '../dto/activityLog.dto';
import { success } from '../../../utils/responses';
import { AuthenticatedRequest } from '../../../core/types';
import { getActiveBancaId } from '../../../middlewares/bancaContext.middleware';
import { Role } from '../../../generated/prisma/client';
import { AppError } from '../../../core/errors';

export const ActivityLogController = {
  async getById(req: AuthenticatedRequest, res: Response) {
    const { id } = req.params;
    const bancaId = getActiveBancaId(req);
    const log = await ActivityLogService.getById(id, bancaId);
    return success(res, log);
  },

  async list(req: AuthenticatedRequest, res: Response) {
    const query = req.query as unknown as ListActivityLogsQuery;
    const bancaId = getActiveBancaId(req);

    // SEGURIDAD EXTRA: Un usuario BANCA NUNCA debe ver logs sin bancaId (globales)
    // Si por alguna razón el middleware no resolvió una banca, forzamos el error
    if (req.user?.role === Role.BANCA && !bancaId) {
      throw new AppError('No se pudo determinar el contexto de banca para esta consulta. Por favor, selecciona una banca o contacta al administrador.', 403);
    }

    const result = await ActivityLogService.list(query, bancaId);
    return success(res, result.data, result.meta);
  },

  async getByUser(req: AuthenticatedRequest, res: Response) {
    const { userId } = req.params;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    const bancaId = getActiveBancaId(req);
    const result = await ActivityLogService.getByUser(userId, page, pageSize, bancaId);
    return success(res, result.data, result.meta);
  },

  async getByTarget(req: AuthenticatedRequest, res: Response) {
    const { targetType, targetId } = req.params;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    const bancaId = getActiveBancaId(req);
    const result = await ActivityLogService.getByTarget(targetType, targetId, page, pageSize, bancaId);
    return success(res, result.data, result.meta);
  },

  async getByAction(req: AuthenticatedRequest, res: Response) {
    const { action } = req.params;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    const bancaId = getActiveBancaId(req);
    const result = await ActivityLogService.getByAction(action as any, page, pageSize, bancaId);
    return success(res, result.data, result.meta);
  },

  async cleanup(req: AuthenticatedRequest, res: Response) {
    const { days } = req.body;
    const bancaId = getActiveBancaId(req);
    const result = await ActivityLogService.cleanupOldLogs(days || 45, bancaId);
    return success(res, result);
  },
};

export default ActivityLogController;
