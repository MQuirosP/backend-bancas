import { Request, Response } from "express";
import { VendedorService } from "../services/vendedor.service";
import { AuthenticatedRequest } from "../../../core/types";
import { Role } from "@prisma/client";
import prisma from "../../../core/prismaClient";

export const VendedorController = {
  async create(req: AuthenticatedRequest, res: Response) {
    // necesitamos ventanaId del actor si es VENTANA
    let ventanaId: string | null = null;
    if (req.user?.role === Role.VENTANA) {
      const actor = await prisma.user.findUnique({ where: { id: req.user.id } });
      ventanaId = actor?.ventanaId ?? null;
    }
    const current = { id: req.user!.id, role: req.user!.role, ventanaId };
    const user = await VendedorService.create(req.body, current);
    res.status(201).json({ success: true, data: user });
  },

  async update(req: AuthenticatedRequest, res: Response) {
    let ventanaId: string | null = null;
    if (req.user?.role === Role.VENTANA) {
      const actor = await prisma.user.findUnique({ where: { id: req.user.id } });
      ventanaId = actor?.ventanaId ?? null;
    }
    const current = { id: req.user!.id, role: req.user!.role, ventanaId };
    const user = await VendedorService.update(req.params.id, req.body, current);
    res.json({ success: true, data: user });
  },

  async delete(req: AuthenticatedRequest, res: Response) {
    let ventanaId: string | null = null;
    if (req.user?.role === Role.VENTANA) {
      const actor = await prisma.user.findUnique({ where: { id: req.user.id } });
      ventanaId = actor?.ventanaId ?? null;
    }
    const current = { id: req.user!.id, role: req.user!.role, ventanaId };
    const user = await VendedorService.softDelete(req.params.id, current, req.body?.reason);
    res.json({ success: true, data: user });
  },

  async restore(req: AuthenticatedRequest, res: Response) {
    let ventanaId: string | null = null;
    if (req.user?.role === Role.VENTANA) {
      const actor = await prisma.user.findUnique({ where: { id: req.user.id } });
      ventanaId = actor?.ventanaId ?? null;
    }
    const current = { id: req.user!.id, role: req.user!.role, ventanaId };
    const user = await VendedorService.restore(req.params.id, current, req.body?.reason);
    res.json({ success: true, data: user });
  },

  async findAll(req: AuthenticatedRequest, res: Response) {
    const page = req.query.page ? Number(req.query.page) : undefined;
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;
    const ventanaIdFilter = req.query.ventanaId ? String(req.query.ventanaId) : undefined;

    let ventanaId: string | null = null;
    if (req.user?.role === Role.VENTANA) {
      const actor = await prisma.user.findUnique({ where: { id: req.user.id } });
      ventanaId = actor?.ventanaId ?? null;
    }
    const current = { id: req.user!.id, role: req.user!.role, ventanaId };
    const result = await VendedorService.findAll(current, page, pageSize, ventanaIdFilter, search);
    res.json({ success: true, data: result.data, meta: result.meta });
  },

  async findById(req: AuthenticatedRequest, res: Response) {
    let ventanaId: string | null = null;
    if (req.user?.role === Role.VENTANA) {
      const actor = await prisma.user.findUnique({ where: { id: req.user.id } });
      ventanaId = actor?.ventanaId ?? null;
    }
    const current = { id: req.user!.id, role: req.user!.role, ventanaId };
    const user = await VendedorService.findById(req.params.id, current);
    res.json({ success: true, data: user });
  },
};
