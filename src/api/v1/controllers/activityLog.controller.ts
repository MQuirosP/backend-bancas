import { Request, Response } from 'express';
import ActivityLogService from '../services/activityLog.service';
import { ListActivityLogsQuery } from '../dto/activityLog.dto';
import { success } from '../../../utils/responses';

export const ActivityLogController = {
  async getById(req: Request, res: Response) {
    const { id } = req.params;
    const log = await ActivityLogService.getById(id);
    return success(res, log);
  },

  async list(req: Request, res: Response) {
    const query = req.query as unknown as ListActivityLogsQuery;
    const result = await ActivityLogService.list(query);
    return success(res, result.data, {
      meta: result.meta,
    });
  },

  async getByUser(req: Request, res: Response) {
    const { userId } = req.params;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    const result = await ActivityLogService.getByUser(userId, page, pageSize);
    return success(res, result.data, {
      meta: result.meta,
    });
  },

  async getByTarget(req: Request, res: Response) {
    const { targetType, targetId } = req.params;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    const result = await ActivityLogService.getByTarget(targetType, targetId, page, pageSize);
    return success(res, result.data, {
      meta: result.meta,
    });
  },

  async getByAction(req: Request, res: Response) {
    const { action } = req.params;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    const result = await ActivityLogService.getByAction(action as any, page, pageSize);
    return success(res, result.data, {
      meta: result.meta,
    });
  },

  async cleanup(req: Request, res: Response) {
    const { days } = req.body;
    const result = await ActivityLogService.cleanupOldLogs(days || 45);
    return success(res, result);
  },
};

export default ActivityLogController;
