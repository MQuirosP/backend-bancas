import { Response } from "express";
import { z } from "zod";
import { Role } from "../../../generated/prisma/client";
import { AppError } from "../../../core/errors";
import prisma from "../../../core/prismaClient";
import { AuthenticatedRequest } from "../../../core/types";
import { PremiaticoService } from "../../../domain/premiatico/premiatico.service";
import { success } from "../../../utils/responses";

const createSaleSchema = z.object({
  campaignId: z.string().min(1, "campaignId es requerido"),
  comboId: z.string().min(1, "comboId es requerido"),
  customer: z.object({
    name: z.string().trim().min(2, "Nombre del cliente requerido").max(120),
    phone: z.string().trim().min(6, "Teléfono del cliente requerido").max(30),
    email: z.string().trim().email("Correo inválido").optional().or(z.literal("")),
    idNumber: z.string().trim().max(40).optional(),
  }),
  selectionMode: z.enum(["RANDOM", "MANUAL"]),
  selectedNumbers: z.array(z.string().trim().min(1).max(10)).optional(),
  includeInverse: z.boolean().optional(),
  idempotencyKey: z.string().trim().min(4).max(120).optional(),
  vendedorId: z.string().uuid().optional(),
});

const toggleConfigSchema = z.object({
  enabled: z.boolean(),
});

export const PremiaticoController = {
  async getCampaigns(req: AuthenticatedRequest, res: Response) {
    const userId = req.user!.id;
    const dbUser = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        settings: true,
        bancaId: true,
        ventana: { select: { bancaId: true } },
      },
    });

    const bancaId =
      req.bancaContext?.bancaId ?? dbUser?.bancaId ?? dbUser?.ventana?.bancaId ?? null;

    const campaigns = await PremiaticoService.getCampaigns(bancaId, dbUser?.settings);
    return success(res, campaigns);
  },

  async createSale(req: AuthenticatedRequest, res: Response) {
    const parsed = createSaleSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        parsed.error.issues[0]?.message || "Datos de venta Premiático inválidos",
        400,
        "VALIDATION_ERROR",
      );
    }

    const body = parsed.data;
    const result = await PremiaticoService.createSale(
      {
        ...body,
        customer: {
          ...body.customer,
          email: body.customer.email ? body.customer.email : undefined,
        },
      },
      {
        id: req.user!.id,
        role: req.user!.role,
        name: (req.user as any)?.name ?? null,
        bancaId: req.bancaContext?.bancaId ?? req.user!.bancaId ?? null,
        ventanaId: req.user!.ventanaId ?? null,
      },
    );

    return res.status(result.idempotentHit ? 200 : 201).json({
      success: true,
      data: result,
    });
  },

  async getBancaConfig(req: AuthenticatedRequest, res: Response) {
    const { bancaId } = req.params;
    if (
      req.user!.role === Role.BANCA &&
      bancaId !== (req.bancaContext?.bancaId ?? req.user!.bancaId)
    ) {
      throw new AppError("No tienes permisos para consultar otra banca", 403, "FORBIDDEN");
    }

    const enabled = await PremiaticoService.isPremiaticoEnabledForBanca(bancaId);
    return success(res, { bancaId, enabled });
  },

  async updateBancaConfig(req: AuthenticatedRequest, res: Response) {
    const parsed = toggleConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError("Campo 'enabled' booleano requerido", 400, "VALIDATION_ERROR");
    }

    const { bancaId } = req.params;
    if (
      req.user!.role === Role.BANCA &&
      bancaId !== (req.bancaContext?.bancaId ?? req.user!.bancaId)
    ) {
      throw new AppError("No tienes permisos para configurar otra banca", 403, "FORBIDDEN");
    }

    const result = await PremiaticoService.updateBancaConfig(
      bancaId,
      parsed.data.enabled,
      req.user!.id,
    );
    return success(res, result);
  },

  async updateUserConfig(req: AuthenticatedRequest, res: Response) {
    const parsed = toggleConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError("Campo 'enabled' booleano requerido", 400, "VALIDATION_ERROR");
    }

    const { userId } = req.params;
    const result = await PremiaticoService.updateUserConfig(
      userId,
      parsed.data.enabled,
      req.user!.id,
      req.user!.role,
      req.bancaContext?.bancaId ?? req.user!.bancaId ?? null,
    );
    return success(res, result);
  },
};
