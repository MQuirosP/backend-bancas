import { Request, Response } from "express";
import { TicketService } from "../services/ticket.service";
import { AuthenticatedRequest } from "../../../core/types";
import { success } from "../../../utils/responses";

export const TicketController = {
  async create(req: AuthenticatedRequest, res: Response) {
    const userId = req.user!.id;
    const result = await TicketService.create(req.body, userId, req.requestId);
    return success(res, result);
  },

  async getById(req: Request, res: Response) {
    const result = await TicketService.getById(req.params.id);
    return success(res, result);
  },

  async list(req: Request, res: Response) {
    const { page = 1, pageSize = 10, ...filters } = req.query;
    const result = await TicketService.list(
      Number(page),
      Number(pageSize),
      filters
    );
    return success(res, result);
  },

  async cancel(req: AuthenticatedRequest, res: Response) {
    const userId = req.user!.id;
    const result = await TicketService.cancel(
      req.params.id,
      userId,
      req.requestId
    );
    return success(res, result);
  },
};
