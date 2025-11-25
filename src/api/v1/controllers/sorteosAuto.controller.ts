// src/api/v1/controllers/sorteosAuto.controller.ts
import { Response } from 'express';
import { AuthenticatedRequest } from '../../../core/types';
import SorteosAutoService from '../services/sorteosAuto.service';
import { success } from '../../../utils/responses';

export const SorteosAutoController = {
  async getConfig(req: AuthenticatedRequest, res: Response) {
    const config = await SorteosAutoService.getConfig();
    return success(res, config);
  },

  async updateConfig(req: AuthenticatedRequest, res: Response) {
    const config = await SorteosAutoService.updateConfig(req.body, req.user!.id);
    return success(res, config);
  },

  async executeAutoOpen(req: AuthenticatedRequest, res: Response) {
    // ✅ Pasar userId del JWT autenticado al servicio
    const result = await SorteosAutoService.executeAutoOpen(req.user!.id);
    return success(res, result);
  },

  async executeAutoCreate(req: AuthenticatedRequest, res: Response) {
    const daysAhead = req.query.daysAhead
      ? Number(req.query.daysAhead)
      : 7;
    // ✅ Pasar userId del JWT autenticado al servicio
    const result = await SorteosAutoService.executeAutoCreate(daysAhead, req.user!.id);
    return success(res, result);
  },

  async getHealthStatus(req: AuthenticatedRequest, res: Response) {
    const status = await SorteosAutoService.getHealthStatus();
    return success(res, status);
  },
};

