import { Request, Response } from "express";
import { Role } from "@prisma/client";
import MultiplierOverrideService from "../services/multiplierOverride.service";
import { success, created as createdResponse } from "../../../utils/responses";

type Actor = {
  id: string;
  role: Role;
  ventanaId?: string | null;
};

export const MultiplierOverrideController = {
  async create(req: Request, res: Response) {
    const actor = req.user as Actor;
    const result = await MultiplierOverrideService.create(actor, req.body);
    return createdResponse(res, result);
  },

  async update(req: Request, res: Response) {
    const actor = req.user as Actor;
    const result = await MultiplierOverrideService.update(actor, req.params.id, req.body);
    return success(res, result);
  },

  async remove(req: Request, res: Response) {
    const actor = req.user as Actor;
    const deletedReason = req.body?.deletedReason || undefined;
    const result = await MultiplierOverrideService.softDelete(actor, req.params.id, deletedReason);
    return success(res, result);
  },

  async restore(req: Request, res: Response) {
    const actor = req.user as Actor;
    const result = await MultiplierOverrideService.restore(actor, req.params.id);
    return success(res, result);
  },

  async getById(req: Request, res: Response) {
    const actor = req.user as Actor;
    const result = await MultiplierOverrideService.getById(actor, req.params.id);
    return success(res, result);
  },

  async list(req: Request, res: Response) {
    const actor = req.user as Actor;
    const result = await MultiplierOverrideService.list(actor, req.query as any);
    return success(res, result.data, {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      pages: result.pages,
    });
  },
};

export default MultiplierOverrideController;
