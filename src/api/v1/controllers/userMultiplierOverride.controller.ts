import { Request, Response } from "express";
import UserMultiplierOverrrideService from "../services/userMultiplierOverride.service";
import { success, created as createdResponse } from "../../../utils/responses";
import { Role } from "@prisma/client";

export const UserMultiplierOverrideController = {
  async create(req: Request, res: Response) {
    const actor = req.user as {
      id: string;
      role: Role;
      ventanaId?: string | null;
    };
    const result = await UserMultiplierOverrrideService.create(actor, req.body);
    return createdResponse(res, result);
  },

  async update(req: Request, res: Response) {
    const actor = req.user as {
      id: string;
      role: Role;
      ventanaId?: string | null;
    };
    const result = await UserMultiplierOverrrideService.update(
      actor,
      req.params.id,
      req.body
    );
    return success(res, result);
  },

  async remove(req: Request, res: Response) {
    const actor = req.user as {
      id: string;
      role: Role;
      ventanaId?: string | null;
    };
    await UserMultiplierOverrrideService.softDelete(
      actor,
      req.params.id,
      (req.body && req.body.deletedReason) || undefined
    );
    return success(res, { deleted: true });
  },

  async getById(req: Request, res: Response) {
    const actor = req.user as {
      id: string;
      role: Role;
      ventanaId?: string | null;
    };
    const result = await UserMultiplierOverrrideService.getById(
      actor,
      req.params.id
    );
    return success(res, result);
  },

  async list(req: Request, res: Response) {
    const actor = req.user as {
      id: string;
      role: Role;
      ventanaId?: string | null;
    };
    const result = await UserMultiplierOverrrideService.list(
      actor,
      req.query as any
    );
    return success(res, result);
  },

  // src/api/v1/controllers/multiplierOverride.controller.ts
  async restore(req: Request, res: Response) {
    const actor = req.user as {
      id: string;
      role: Role;
      ventanaId?: string | null;
    };
    const result = await UserMultiplierOverrrideService.restore(
      actor,
      req.params.id
    );
    return success(res, result);
  },
};

export default UserMultiplierOverrideController;
