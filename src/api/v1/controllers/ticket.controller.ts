import { Request, Response } from 'express';
import { TicketService } from '../services/ticket.service';
import { ActivityType } from '@prisma/client';
import ActivityService from '../../../core/activity.service';
import logger from '../../../core/logger';
import { success, created } from '../../../utils/responses';

export const TicketController = {
  async create(req: Request, res: Response) {
    const userId = (req as any)?.user?.id ?? null;
    const requestId = (req as any)?.requestId ?? null;

    const ticket = await TicketService.create(req.body, userId!, requestId);

    // Logger estructurado
    (req as any)?.logger?.info({
      layer: 'controller',
      action: 'TICKET_CREATE',
      userId,
      requestId,
      payload: { ticketId: ticket.id, totalAmount: ticket.totalAmount },
    });

    // Registrar en ActivityLog
    await ActivityService.log({
      userId,
      action: ActivityType.TICKET_CREATE,
      targetType: 'TICKET',
      targetId: ticket.id,
      details: { ticketNumber: ticket.ticketNumber, total: ticket.totalAmount },
      requestId,
      layer: 'controller',
    });

    return created(res, ticket);
  },

  async getById(req: Request, res: Response) {
    const ticket = await TicketService.getById(req.params.id);
    (req as any)?.logger?.info({
      layer: 'controller',
      action: 'TICKET_GET_BY_ID',
      requestId: (req as any)?.requestId ?? null,
      payload: { ticketId: req.params.id },
    });
    return success(res, ticket);
  },

  async list(req: Request, res: Response) {
    const { data, meta } = await TicketService.list({
      page: req.query.page ? Number(req.query.page) : undefined,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
    });
    (req as any)?.logger?.info({
      layer: 'controller',
      action: 'TICKET_LIST',
      requestId: (req as any)?.requestId ?? null,
      payload: { page: req.query.page, pageSize: req.query.pageSize },
    });
    return success(res, data, meta);
  },

  async cancel(req: Request, res: Response) {
    const userId = (req as any)?.user?.id ?? null;
    const requestId = (req as any)?.requestId ?? null;

    const ticket = await TicketService.cancel(req.params.id, userId!, requestId);

    (req as any)?.logger?.info({
      layer: 'controller',
      action: 'TICKET_CANCEL',
      userId,
      requestId,
      payload: { ticketId: req.params.id },
    });

    await ActivityService.log({
      userId,
      action: ActivityType.TICKET_CANCEL,
      targetType: 'TICKET',
      targetId: req.params.id,
      details: { cancelledAt: new Date().toISOString() },
      requestId,
      layer: 'controller',
    });

    return success(res, ticket);
  },
};
