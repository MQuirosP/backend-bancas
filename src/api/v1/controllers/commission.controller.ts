// src/api/v1/controllers/commission.controller.ts
import { Response } from "express";
import { AuthenticatedRequest } from "../../../core/types";
import { success } from "../../../utils/responses";
import { AppError } from "../../../core/errors";
import prisma from "../../../core/prismaClient";
import { Prisma } from "../../../generated/prisma/client";
import { CacheService } from "../../../core/cache.service";

type MultiplierEmbed = {
  id: string;
  name: string;
  valueX: number;
  kind: string;
  loteriaId: string;
  isActive: boolean;
};

type RuleWithEmbed = {
  loteriaId?: string | null;
  betType?: string | null;
  multiplierRange?: { min: number; max: number };
  multiplier?: MultiplierEmbed | null;
  loteria?: { id: string; name: string } | null;
  [key: string]: unknown;
};

/**
 * Embebe el objeto multiplier y el objeto loteria en cada regla de la política para que el FE
 * no tenga que lanzar N queries ni cruzar por ID a ciegas en entornos multi-tenant.
 */
async function embedMultipliersInPolicy(
  policyJson: Prisma.JsonValue | null
): Promise<Prisma.JsonValue | null> {
  if (!policyJson || typeof policyJson !== "object" || Array.isArray(policyJson)) {
    return policyJson;
  }

  const policy = policyJson as { rules?: unknown[] };
  if (!Array.isArray(policy.rules) || policy.rules.length === 0) {
    return policyJson;
  }

  const rules = policy.rules as RuleWithEmbed[];

  // 1. Obtener todas las loterías presentes en las reglas para embeberlas
  const allLoteriaIds = [...new Set(rules.map((r) => r.loteriaId).filter(Boolean) as string[])];
  const loterias = allLoteriaIds.length > 0
    ? await prisma.loteria.findMany({
        where: { id: { in: allLoteriaIds } },
        select: { id: true, name: true, rulesJson: true },
      })
    : [];

  const loteriaLookup = new Map<string, { id: string; name: string; reventadoEnabled: boolean }>();
  for (const l of loterias) {
    const rulesObj = (l.rulesJson ?? {}) as any;
    const reventadoEnabled = rulesObj?.reventadoConfig?.enabled === true;
    loteriaLookup.set(l.id, { id: l.id, name: l.name, reventadoEnabled });
  }

  // Reglas elegibles para multiplicador: tienen loteriaId y multiplicador específico (min === max)
  const eligibleRules = rules.filter(
    (r) =>
      r.loteriaId &&
      r.multiplierRange &&
      r.multiplierRange.min === r.multiplierRange.max
  );

  const loteriaIdsForMultipliers = [...new Set(eligibleRules.map((r) => r.loteriaId as string))];

  // Un solo query para todos los multiplicadores base activos de las loterías presentes
  const multipliers = loteriaIdsForMultipliers.length > 0
    ? await prisma.loteriaMultiplier.findMany({
        where: {
          loteriaId: { in: loteriaIdsForMultipliers },
          isActive: true,
          appliesToDate: null,
          appliesToSorteoId: null,
        },
        select: {
          id: true,
          name: true,
          valueX: true,
          kind: true,
          loteriaId: true,
          isActive: true,
        },
      })
    : [];

  // Índice: "${loteriaId}:${valueX}:${kind}" → primer multiplicador encontrado
  const lookup = new Map<string, MultiplierEmbed>();
  for (const m of multipliers) {
    const key = `${m.loteriaId}:${m.valueX}:${m.kind}`;
    if (!lookup.has(key)) lookup.set(key, m);
  }

  const enrichedRules = rules.map((rule): RuleWithEmbed => {
    const loteria = rule.loteriaId ? (loteriaLookup.get(rule.loteriaId) ?? null) : null;

    if (!rule.loteriaId || !rule.multiplierRange || rule.multiplierRange.min !== rule.multiplierRange.max) {
      return { ...rule, loteria, multiplier: null };
    }
    const valueX = rule.multiplierRange.min;
    // betType null → intentar con NUMERO como fallback
    const kind = rule.betType ?? "NUMERO";
    const multiplier = lookup.get(`${rule.loteriaId}:${valueX}:${kind}`) ?? null;
    return { ...rule, loteria, multiplier };
  });

  return { ...policy, rules: enrichedRules } as Prisma.JsonValue;
}

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

    await CacheService.invalidateTag(`banca:${id}`);

    // OPTIMIZACIÓN: Al no usar tags per-user en sesión, borramos explícitamente las sesiones de todos los usuarios vinculados a esta banca
    try {
      const usersInBanca = await prisma.user.findMany({
        where: {
          OR: [
            { bancaId: id },
            { ventana: { bancaId: id } }
          ]
        },
        select: { id: true }
      });
      for (const u of usersInBanca) {
        await CacheService.del(`auth:session:${u.id}`).catch(() => {});
      }
    } catch (cacheErr: any) {
      req.logger?.warn({
        layer: "controller",
        action: "BANCA_COMMISSION_CACHE_INVALIDATE_WARN",
        payload: { bancaId: id, error: cacheErr.message }
      });
    }

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

    const commissionPolicyJson = await embedMultipliersInPolicy(banca.commissionPolicyJson);
    return success(res, { ...banca, commissionPolicyJson });
  },

  /**
   * PUT /ventanas/:id/commission-policy
   * Actualizar política de comisiones de una ventana
   * ADMIN puede gestionar cualquier ventana, VENTANA solo su propia ventana
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

    await CacheService.invalidateTag(`ventana:${id}`);

    // OPTIMIZACIÓN: Al no usar tags per-user en sesión, borramos explícitamente las sesiones de todos los usuarios vinculados a esta ventana
    try {
      const usersInVentana = await prisma.user.findMany({
        where: { ventanaId: id },
        select: { id: true }
      });
      for (const u of usersInVentana) {
        await CacheService.del(`auth:session:${u.id}`).catch(() => {});
      }
    } catch (cacheErr: any) {
      req.logger?.warn({
        layer: "controller",
        action: "VENTANA_COMMISSION_CACHE_INVALIDATE_WARN",
        payload: { ventanaId: id, error: cacheErr.message }
      });
    }

    req.logger?.info({
      layer: "controller",
      action: "UPDATE_VENTANA_COMMISSION_POLICY",
      payload: { ventanaId: id, policySet: commissionPolicyJson !== null },
    });

    return success(res, updated);
  },

  /**
   * GET /ventanas/:id/commission-policy
   * Obtener política de comisiones de una ventana
   * ADMIN puede ver cualquier ventana, VENTANA solo su propia ventana
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

    const commissionPolicyJson = await embedMultipliersInPolicy(ventana.commissionPolicyJson);
    return success(res, { ...ventana, commissionPolicyJson });
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

    await CacheService.invalidateTag(`user:${id}`);
    await CacheService.del(`auth:session:${id}`).catch(() => {});

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

    const commissionPolicyJson = await embedMultipliersInPolicy(user.commissionPolicyJson);
    return success(res, { ...user, commissionPolicyJson });
  },
};

export default CommissionController;
