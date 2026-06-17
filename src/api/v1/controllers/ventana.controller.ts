import { Response } from "express";
import { Role } from "../../../generated/prisma/client";
import { VentanaService } from "../services/ventana.service";
import { AuthenticatedRequest } from "../../../core/types";

export const VentanaController = {
  async create(req: AuthenticatedRequest, res: Response) {
    // Si es rol BANCA, forzar su propio bancaId. Si es ADMIN, usar el del body.
    const actor = req.user!;
    // Prioridad: 1. Body (si es ADMIN), 2. Contexto de Banca Activa, 3. Perfil de Usuario
    const bancaId = actor.role === Role.ADMIN 
      ? (req.body.bancaId || req.bancaContext?.bancaId) 
      : (req.bancaContext?.bancaId || actor.bancaId);

    if (!bancaId) {
      return res.status(400).json({ success: false, message: "No se proporcionó un ID de banca válido" });
    }

    const result = await VentanaService.create({ ...req.body, bancaId }, actor.id);
    const { _meta, ...ventanaData } = result as any;
    
    res.status(201).json({
      success: true,
      message: "Listero y usuario creados correctamente",
      data: ventanaData,
      meta: _meta || { userCreated: false },
    });
  },

  async update(req: AuthenticatedRequest, res: Response) {
    const { id } = req.params;
    const ventana = await VentanaService.update(id, req.body, req.user!.id);
    res.json({ success: true, data: ventana });
  },

  async delete(req: AuthenticatedRequest, res: Response) {
    const { id } = req.params;
    const { reason } = req.body;
    const ventana = await VentanaService.softDelete(id, req.user!.id, reason);
    res.json({ success: true, data: ventana });
  },

  async findAll(req: AuthenticatedRequest, res: Response) {
    const page = req.query.page ? Number(req.query.page) : 1;
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 10;
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    
    let isActive: boolean | undefined = undefined;
    if (String(req.query.isActive) === "true") isActive = true;
    else if (String(req.query.isActive) === "false") isActive = false;

    const bancaId = req.bancaContext?.bancaId ?? undefined;
    const result = await VentanaService.findAll(page, pageSize, search, isActive, bancaId);
    res.json({ success: true, data: result.data, meta: result.meta });
  },

  async findById(req: AuthenticatedRequest, res: Response) {
    const { id } = req.params;
    const ventana = await VentanaService.findById(id);
    res.json({ success: true, data: ventana });
  },

  async restore(req: AuthenticatedRequest, res: Response) {
    const { id } = req.params;
    const { reason } = req.body;
    const ventana = await VentanaService.restore(id, req.user!.id, reason);
    res.json({ success: true, data: ventana });
  },
};
