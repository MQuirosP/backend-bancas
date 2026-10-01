import { Response } from "express";
import { AuthenticatedRequest } from "../../../core/types";
import { VendorCreditService } from "../../../domain/credit/vendorCredit.service";
import { success } from "../../../utils/responses";
import { getActiveBancaId } from "../../../middlewares/bancaContext.middleware";
import { Role } from "../../../generated/prisma/client";

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
   */
  async getStatusMe(req: AuthenticatedRequest, res: Response) {
    const user = req.user!;
    const result = await VendorCreditService.getVendorsCreditStatus(
      {
        id: user.id,
        role: user.role as Role,
        bancaId: user.bancaId,
        ventanaId: user.ventanaId,
      },
      {
        requestedVendedorIds: [user.id],
      }
    );

    return success(res, result);
  },
};

export default CreditController;
