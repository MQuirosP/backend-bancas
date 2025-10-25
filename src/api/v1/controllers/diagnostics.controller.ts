// src/api/v1/controllers/diagnostics.controller.ts
import { Response } from "express";
import prisma from "../../../core/prismaClient";
import { AuthenticatedRequest } from "../../../core/types";
import { AppError } from "../../../core/errors";
import { RestrictionRuleRepository } from "../../../repositories/restrictionRule.repository";

const CUTOFF_GRACE_MS = 5000;

export const DiagnosticsController = {
  async cutoffInspect(req: AuthenticatedRequest, res: Response) {
    const userId = req.query.userId ? String(req.query.userId) : req.user!.id; // por defecto, actor
    const ventanaId = req.query.ventanaId ? String(req.query.ventanaId) : undefined;
    const sorteoId = req.query.sorteoId ? String(req.query.sorteoId) : undefined;

    if (!ventanaId || !sorteoId) {
      throw new AppError("ventanaId y sorteoId son requeridos", 400);
    }

    const ventana = await prisma.ventana.findUnique({
      where: { id: ventanaId },
      select: { id: true, bancaId: true, isActive: true },
    });
    if (!ventana || !ventana.isActive) {
      throw new AppError("Ventana no encontrada o inactiva", 404);
    }

    const sorteo = await prisma.sorteo.findUnique({
      where: { id: sorteoId },
      select: { id: true, scheduledAt: true, status: true },
    });
    if (!sorteo) throw new AppError("Sorteo no encontrado", 404);

    const cutoff = await RestrictionRuleRepository.resolveSalesCutoff({
      bancaId: ventana.bancaId,
      ventanaId,
      userId,
      defaultCutoff: 5,
    });

    const now = new Date();
    const cutoffMs = cutoff.minutes * 60_000;
    const limitTime = new Date(sorteo.scheduledAt.getTime() - cutoffMs);
    const effectiveLimitTime = new Date(limitTime.getTime() + CUTOFF_GRACE_MS);
    const blocks = now >= effectiveLimitTime;

    res.json({
      success: true,
      data: {
        input: { userId, ventanaId, sorteoId },
        now: now.toISOString(),
        scheduledAt: sorteo.scheduledAt.toISOString(),
        cutoffMinutes: cutoff.minutes,
        cutoffSource: cutoff.source,
        graceMs: CUTOFF_GRACE_MS,
        limitTime: limitTime.toISOString(),
        effectiveLimitTime: effectiveLimitTime.toISOString(),
        secondsUntilLimit: Math.max(0, Math.ceil((effectiveLimitTime.getTime() - now.getTime()) / 1000)),
        secondsUntilScheduled: Math.max(0, Math.ceil((sorteo.scheduledAt.getTime() - now.getTime()) / 1000)),
        sorteoStatus: sorteo.status,
        blocks,
      },
    });
  },
};

export default DiagnosticsController;
