// src/api/v1/controllers/commission.controller.ts
import { Response } from "express";
import { AuthenticatedRequest } from "../../../core/types";
import { success } from "../../../utils/responses";
import { AppError } from "../../../core/errors";
import prisma from "../../../core/prismaClient";

export const CommissionController = {
  /**
   * PUT /bancas/:id/commission-policy
   * Actualizar política de comisiones de una banca (ADMIN only)
   */
  async updateBancaCommissionPolicy(req: AuthenticatedRequest, res: Response) {
    const { id } = req.params;
    const { commissionPolicyJson } = req.body;

    // Validar que la banca existe
    const banca = await prisma.banca.findUnique({ where: { id } });
    if (!banca) {
      throw new AppError("Banca no encontrada", 404, { code: "BANCA_NOT_FOUND" });
    }

    // Actualizar (Zod ya validó y generó UUIDs)
    const updated = await prisma.banca.update({
      where: { id },
      data: { commissionPolicyJson },
      select: {
        id: true,
        name: true,
        code: true,
        commissionPolicyJson: true,
      },
    });

    req.logger?.info({
      layer: "controller",
      action: "UPDATE_BANCA_COMMISSION_POLICY",
      payload: { bancaId: id, policySet: commissionPolicyJson !== null },
    });

    return success(res, updated);
  },

  /**
   * GET /bancas/:id/commission-policy
   * Obtener política de comisiones de una banca (ADMIN only)
   */
  async getBancaCommissionPolicy(req: AuthenticatedRequest, res: Response) {
    const { id } = req.params;

    const banca = await prisma.banca.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        code: true,
        commissionPolicyJson: true,
      },
    });

    if (!banca) {
      throw new AppError("Banca no encontrada", 404, { code: "BANCA_NOT_FOUND" });
    }

    req.logger?.info({
      layer: "controller",
      action: "GET_BANCA_COMMISSION_POLICY",
      payload: { bancaId: id },
    });

    return success(res, banca);
  },

  /**
   * PUT /ventanas/:id/commission-policy
   * Actualizar política de comisiones de una ventana (ADMIN only)
   */
  async updateVentanaCommissionPolicy(req: AuthenticatedRequest, res: Response) {
    const { id } = req.params;
    const { commissionPolicyJson } = req.body;

    // Validar que la ventana existe
    const ventana = await prisma.ventana.findUnique({ where: { id } });
    if (!ventana) {
      throw new AppError("Ventana no encontrada", 404, { code: "VENTANA_NOT_FOUND" });
    }

    // Actualizar (Zod ya validó y generó UUIDs)
    const updated = await prisma.ventana.update({
      where: { id },
      data: { commissionPolicyJson },
      select: {
        id: true,
        name: true,
        code: true,
        commissionPolicyJson: true,
      },
    });

    req.logger?.info({
      layer: "controller",
      action: "UPDATE_VENTANA_COMMISSION_POLICY",
      payload: { ventanaId: id, policySet: commissionPolicyJson !== null },
    });

    return success(res, updated);
  },

  /**
   * GET /ventanas/:id/commission-policy
   * Obtener política de comisiones de una ventana (ADMIN only)
   */
  async getVentanaCommissionPolicy(req: AuthenticatedRequest, res: Response) {
    const { id } = req.params;

    const ventana = await prisma.ventana.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        code: true,
        commissionPolicyJson: true,
      },
    });

    if (!ventana) {
      throw new AppError("Ventana no encontrada", 404, { code: "VENTANA_NOT_FOUND" });
    }

    req.logger?.info({
      layer: "controller",
      action: "GET_VENTANA_COMMISSION_POLICY",
      payload: { ventanaId: id },
    });

    return success(res, ventana);
  },

  /**
   * PUT /users/:id/commission-policy
   * Actualizar política de comisiones de un usuario (ADMIN only)
   */
  async updateUserCommissionPolicy(req: AuthenticatedRequest, res: Response) {
    const { id } = req.params;
    const { commissionPolicyJson } = req.body;

    // Validar que el usuario existe
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new AppError("Usuario no encontrado", 404, { code: "USER_NOT_FOUND" });
    }

    // Actualizar (Zod ya validó y generó UUIDs)
    const updated = await prisma.user.update({
      where: { id },
      data: { commissionPolicyJson },
      select: {
        id: true,
        name: true,
        username: true,
        role: true,
        commissionPolicyJson: true,
      },
    });

    req.logger?.info({
      layer: "controller",
      action: "UPDATE_USER_COMMISSION_POLICY",
      payload: { userId: id, policySet: commissionPolicyJson !== null },
    });

    return success(res, updated);
  },

  /**
   * GET /users/:id/commission-policy
   * Obtener política de comisiones de un usuario (ADMIN only)
   */
  async getUserCommissionPolicy(req: AuthenticatedRequest, res: Response) {
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        username: true,
        role: true,
        commissionPolicyJson: true,
      },
    });

    if (!user) {
      throw new AppError("Usuario no encontrado", 404, { code: "USER_NOT_FOUND" });
    }

    req.logger?.info({
      layer: "controller",
      action: "GET_USER_COMMISSION_POLICY",
      payload: { userId: id },
    });

    return success(res, user);
  },
};

export default CommissionController;
