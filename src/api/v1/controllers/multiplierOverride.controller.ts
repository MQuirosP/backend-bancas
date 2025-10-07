import { Request, Response } from "express";
import MultiplierOverrideService from "../../v1/services/multiplierOverride.service";
import { success, created as createdResponse } from "../../../utils/responses";
import { Role } from "@prisma/client";

export const MultiplierOverrideController = {
  async create(req: Request, res: Response) {
    const actor = req.user as { id: string; role: Role; ventanaId?: string | null };
    const result = await MultiplierOverrideService.create(actor, req.body);
    return createdResponse(res, result);
  },

  async update(req: Request, res: Response) {
    const actor = req.user as { id: string; role: Role; ventanaId?: string | null };
    const result = await MultiplierOverrideService.update(actor, req.params.id, req.body);
    return success(res, result);
  },

  async remove(req: Request, res: Response) {
    const actor = req.user as { id: string; role: Role; ventanaId?: string | null };
    await MultiplierOverrideService.remove(actor, req.params.id);
    return success(res, { deleted: true });
  },

  async getById(req: Request, res: Response) {
    const actor = req.user as { id: string; role: Role; ventanaId?: string | null };
    const result = await MultiplierOverrideService.getById(actor, req.params.id);
    return success(res, result);
  },

  async list(req: Request, res: Response) {
    const actor = req.user as { id: string; role: Role; ventanaId?: string | null };
    const result = await MultiplierOverrideService.list(actor, req.query as any);
    return success(res, result);
  },
};

export default MultiplierOverrideController;
