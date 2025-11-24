import { Response } from "express";
import { AuthenticatedRequest } from "../../../core/types";
import { RestrictionRuleService } from "../services/restrictionRule.service";

export const RestrictionRuleController = {
  async create(req: AuthenticatedRequest, res: Response) {
    const rule = await RestrictionRuleService.create(req.user!.id, req.body);
    res.status(201).json({ success: true, data: rule });
  },

  async update(req: AuthenticatedRequest, res: Response) {
    const rule = await RestrictionRuleService.update(
      req.user!.id,
      req.params.id,
      req.body
    );
    res.json({ success: true, data: rule });
  },

  async delete(req: AuthenticatedRequest, res: Response) {
    const rule = await RestrictionRuleService.remove(
      req.user!.id,
      req.params.id,
      req.body?.reason
    );
    res.json({ success: true, data: rule });
  },

  async restore(req: AuthenticatedRequest, res: Response) {
    const rule = await RestrictionRuleService.restore(
      req.user!.id,
      req.params.id
    );
    res.json({ success: true, data: rule });
  },

  async findById(req: AuthenticatedRequest, res: Response) {
    const rule = await RestrictionRuleService.getById(req.params.id);
    res.json({ success: true, data: rule });
  },

  async list(req: AuthenticatedRequest, res: Response) {
    const query = req.query as any;

    // Si es ADMIN con banca activa, agregar filtro de bancaId
    if (req.user!.role === 'ADMIN' && req.bancaContext?.bancaId && req.bancaContext.hasAccess) {
      query.bancaId = req.bancaContext.bancaId;
    }

    const result = await RestrictionRuleService.list(query);
    res.json({ success: true, data: result.data, meta: result.meta });
  },

  async getCronHealth(req: AuthenticatedRequest, res: Response) {
    const health = await RestrictionRuleService.getCronHealth();
    res.json({ success: true, data: health });
  },

  async executeCronManually(req: AuthenticatedRequest, res: Response) {
    const result = await RestrictionRuleService.executeCronManually();
    res.json({ success: true, data: result });
  },

  async myRestrictions(req: AuthenticatedRequest, res: Response) {
    const userId = req.user!.id;
    const ventanaId = req.user!.ventanaId || null;
    const bancaId = req.bancaContext?.bancaId || null;

    // If no bancaId is available, return empty restrictions
    if (!bancaId) {
      return res.json({
        success: true,
        data: {
          general: [],
          vendorSpecific: []
        }
      });
    }

    const result = await RestrictionRuleService.forVendor(userId, bancaId, ventanaId);
    res.json({ success: true, data: result });
  },
};
