// src/api/v1/controllers/accountStatementSettlement.controller.ts
import { Response } from 'express';
import { AuthenticatedRequest } from '../../../core/types';
import AccountStatementSettlementService from '../services/accountStatementSettlement.service';
import { success } from '../../../utils/responses';

export const AccountStatementSettlementController = {
  async getConfig(req: AuthenticatedRequest, res: Response) {
    const config = await AccountStatementSettlementService.getConfig();
    return success(res, config);
  },

  async updateConfig(req: AuthenticatedRequest, res: Response) {
    const config = await AccountStatementSettlementService.updateConfig(req.body, req.user!.id);
    return success(res, config);
  },

  async executeSettlement(req: AuthenticatedRequest, res: Response) {
    const result = await AccountStatementSettlementService.executeSettlement(req.user!.id);
    return success(res, result);
  },

  async getHealthStatus(req: AuthenticatedRequest, res: Response) {
    const status = await AccountStatementSettlementService.getHealthStatus();
    return success(res, status);
  }
};

