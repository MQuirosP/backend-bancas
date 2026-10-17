import { Response } from "express";
import { AuthenticatedRequest } from "../../../core/types";
import { VendorCreditService } from "../../../domain/credit/vendorCredit.service";
import { success } from "../../../utils/responses";
import { getActiveBancaId } from "../../../middlewares/bancaContext.middleware";
import { Role } from "../../../generated/prisma/client";

interface CachedStatusMe {
  data: any;
  expiresAt: number;
}

const STATUS_ME_RAM_CACHE_TTL_MS = 4000; // 4s TTL en memoria local (absorbe ráfagas post-evaluación)
const statusMeRamCache = new Map<string, CachedStatusMe>();
const statusMeInFlight = new Map<string, Promise<any>>();

export function clearStatusMeRamCache(userId?: string): void {
  if (userId) {
    statusMeRamCache.delete(userId);
  } else {
    statusMeRamCache.clear();
  }
}

export const CreditController = {
  /**
   * GET /api/v1/credit/status?vendedorIds=uuid1,uuid2
   * Consulta el estado de crédito del vendedor o listado según el alcance del rol autenticado.
   */
  async getStatus(req: AuthenticatedRequest, res: Response) {
    const user = req.user!;
    const activeBancaId = getActiveBancaId(req);

    const rawIds = req.query.vendedorIds as string | undefined;
    let requestedVendedorIds: string[] | undefined;
    if (rawIds && typeof rawIds === "string") {
      requestedVendedorIds = rawIds
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
    }

    const result = await VendorCreditService.getVendorsCreditStatus(
      {
        id: user.id,
        role: user.role as Role,
        bancaId: user.bancaId,
        ventanaId: user.ventanaId,
      },
      {
        activeBancaId,
        requestedVendedorIds,
      }
    );

    return success(res, result);
  },

  /**
   * GET /api/v1/credit/status/me
   * Consulta el estado de crédito del usuario autenticado actual.
   * Con Request Coalescing (SingleFlight) y Short-Lived RAM Cache (4s) para erradicar Thundering Herd.
   */
  async getStatusMe(req: AuthenticatedRequest, res: Response) {
    const user = req.user!;
    const userId = user.id;
    const now = Date.now();

    // 1. Short-Lived RAM Cache Hit (3-5s): 0ms I/O, 0ms Redis
    const cached = statusMeRamCache.get(userId);
    if (cached && cached.expiresAt > now) {
      return success(res, cached.data);
    }

    // 2. Request Coalescing: Si ya hay una consulta en vuelo para este userId, compartir la promesa
    let inFlight = statusMeInFlight.get(userId);
    if (inFlight) {
      const result = await inFlight;
      return success(res, result);
    }

    // 3. Crear promesa en vuelo compartida
    inFlight = (async () => {
      try {
        const result = await VendorCreditService.getVendorsCreditStatus(
          {
            id: user.id,
            role: user.role as Role,
            bancaId: user.bancaId,
            ventanaId: user.ventanaId,
          },
          {
            requestedVendedorIds: [userId],
          }
        );

        // Control de tamaño de RAM Cache
        if (statusMeRamCache.size > 1000) {
          const currentTime = Date.now();
          for (const [key, entry] of statusMeRamCache.entries()) {
            if (entry.expiresAt <= currentTime) statusMeRamCache.delete(key);
          }
        }

        statusMeRamCache.set(userId, {
          data: result,
          expiresAt: Date.now() + STATUS_ME_RAM_CACHE_TTL_MS,
        });

        return result;
      } finally {
        statusMeInFlight.delete(userId);
      }
    })();

    statusMeInFlight.set(userId, inFlight);
    const result = await inFlight;
    return success(res, result);
  },
};

export default CreditController;
