// src/api/v1/controllers/ventanaMultiplierOverride.controller.ts
import { Request, Response } from "express";
import VentanaMultiplierOverrideService from "../services/ventanaMultiplierOverride.service";
import { success, created as createdResponse } from "../../../utils/responses";
import { Role } from "@prisma/client";

export const VentanaMultiplierOverrideController = {
  async create(req: Request, res: Response) {
    const actor = req.user as {
      id: string;
      role: Role;
      ventanaId?: string | null;
    };
    // body debe traer: { ventanaId, loteriaId, baseMultiplierX, multiplierType }
    const result = await VentanaMultiplierOverrideService.create(actor, req.body);
    return createdResponse(res, result);
  },

  async update(req: Request, res: Response) {
    const actor = req.user as {
      id: string;
      role: Role;
      ventanaId?: string | null;
    };
    const result = await VentanaMultiplierOverrideService.update(
      actor,
      req.params.id,
      req.body
    );
    return success(res, result);
  },

  // Baja lógica => isActive = false
  async remove(req: Request, res: Response) {
    const actor = req.user as {
      id: string;
      role: Role;
      ventanaId?: string | null;
    };
    await VentanaMultiplierOverrideService.deactivate(
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
    const result = await VentanaMultiplierOverrideService.getById(
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
    // query ahora soporta ventanaId, loteriaId, page, pageSize
    const result = await VentanaMultiplierOverrideService.list(
      actor,
      req.query as any
    );
    return success(res, result);
  },

  async restore(req: Request, res: Response) {
    const actor = req.user as {
      id: string;
      role: Role;
      ventanaId?: string | null;
    };
    const result = await VentanaMultiplierOverrideService.restore(
      actor,
      req.params.id
    );
    return success(res, result);
  },
};

export default VentanaMultiplierOverrideController;
