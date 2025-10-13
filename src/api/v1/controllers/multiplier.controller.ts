import { Response } from "express";
import { AuthenticatedRequest } from "../../../core/types";
import { AppError } from "../../../core/errors";
import MultiplierService from "../services/mulriplier.service";

function assertAuth(req: AuthenticatedRequest) {
  if (!req.user) throw new AppError("Unauthorized", 401);
}
function assertRole(req: AuthenticatedRequest, roles: Array<"ADMIN"|"VENTANA">) {
  assertAuth(req);
  if (!roles.includes(req.user!.role as any)) {
    throw new AppError("Forbidden", 403);
  }
}

export const MultiplierController = {
  async create(req: AuthenticatedRequest, res: Response) {
    assertRole(req, ["ADMIN","VENTANA"]);
    const r = await MultiplierService.create(req.user!.id, req.body);
    return res.status(201).json({ success: true, data: r });
  },
  async update(req: AuthenticatedRequest, res: Response) {
    assertRole(req, ["ADMIN","VENTANA"]);
    const r = await MultiplierService.update(req.user!.id, req.params.id, req.body);
    return res.json({ success: true, data: r });
  },
  async toggle(req: AuthenticatedRequest, res: Response) {
    assertRole(req, ["ADMIN","VENTANA"]);
    const enabled = req.body?.isActive === true;
    const r = await MultiplierService.toggle(req.user!.id, req.params.id, enabled);
    return res.json({ success: true, data: r });
  },
  async getById(req: AuthenticatedRequest, res: Response) {
    assertAuth(req); // cualquier usuario autenticado
    const r = await MultiplierService.getById(req.params.id);
    return res.json({ success: true, data: r });
  },
  async list(req: AuthenticatedRequest, res: Response) {
    assertAuth(req); // cualquier usuario autenticado
    const r = await MultiplierService.list(req.query);
    return res.json({ success: true, data: r.data, meta: r.meta });
  },
};
export default MultiplierController;
