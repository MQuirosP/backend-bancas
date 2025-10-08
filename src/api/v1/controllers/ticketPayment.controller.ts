import { Request, Response } from "express";
import { AppError } from "../../../core/errors";
import { success, created } from "../../../utils/responses";
import { AuthenticatedRequest } from "../../../core/types";
import { CreatePaymentDTO } from "../dto/ticketPayment.dto";
import TicketPaymentService from "../services/ticketPayment.service";

export const TicketPaymentController = {
  async create(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);
    const data = CreatePaymentDTO.parse(req.body);

    const result = await TicketPaymentService.create(data, req.user);
    return created(res, result);
  },

  async list(req: Request, res: Response) {
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 10);
    const result = await TicketPaymentService.list(page, pageSize);
    return success(res, result);
  },

  async reverse(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);
    const { id } = req.params;

    const result = await TicketPaymentService.reverse(id, req.user.id);
    return success(res, result);
  },
};

export default TicketPaymentController;
