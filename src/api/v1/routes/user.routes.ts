import { Router, Request, Response, NextFunction } from "express";
import UserController from "../controllers/user.controller";
import {
  protect,
  restrictTo,
  restrictToAdminSelfOrVentanaVendor,
} from "../../../middlewares/auth.middleware";
import {
  validateBody,
  validateParams,
  validateQuery,
} from "../../../middlewares/validate.middleware";
import {
  createUserSchema,
  updateUserSchema,
  listUsersQuerySchema,
  ChangePasswordSchema,
  getAllowedMultipliersQuerySchema,
  getAllowedMultipliersParamsSchema,
  getAllowedMultipliersBatchQuerySchema,
  getAllowedMultipliersBatchParamsSchema,
} from "../validators/user.validator";
import { z } from "zod";
import { Role } from "../../../generated/prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import { bancaContextMiddleware } from "../../../middlewares/bancaContext.middleware";
import userBancaRoutes from "./userBanca.routes";

const router = Router();
router.use(protect);
router.use(bancaContextMiddleware);

router.use("/:id/bancas", userBancaRoutes);

const idParamSchema = z.object({ id: z.uuid("Invalid user id") });

// ADMIN-only
router.post(
  "/",
  restrictTo(Role.ADMIN, Role.BANCA, Role.VENTANA),
  validateBody(createUserSchema),
  UserController.create
);
router.patch(
  "/:id",
  restrictToAdminSelfOrVentanaVendor,
  validateParams(idParamSchema),
  validateBody(updateUserSchema),
  UserController.update
);
router.delete(
  "/:id",
  restrictTo(Role.ADMIN, Role.BANCA, Role.VENTANA),
  validateParams(idParamSchema),
  UserController.remove
);
router.patch(
  "/:id/restore",
  restrictTo(Role.ADMIN, Role.BANCA, Role.VENTANA),
  validateParams(idParamSchema),
  UserController.restore
);

// Change password (permite que el usuario autenticado cambie su propia contraseña)
router.put(
  "/me/password",
  validateBody(ChangePasswordSchema),
  UserController.changePassword
);

// List & Get (list admin-only; get self allowed if necesitas, por ahora admin)
router.get(
  "/",
  restrictTo(Role.ADMIN, Role.BANCA, Role.VENTANA),
  validateQuery(listUsersQuerySchema),
  UserController.list
);
router.get(
  "/:id",
  restrictToAdminSelfOrVentanaVendor,
  validateParams(idParamSchema),
  UserController.getById
);

// GET /api/v1/users/:userId/allowed-multipliers
router.get(
  "/:userId/allowed-multipliers",
  async (req: Request, res: Response, next: NextFunction) => {
    const authUser = (req as any)?.user;
    const targetId = req.params.userId;

    if (!authUser) {
      throw new AppError("Unauthorized", 401);
    }

    if (!targetId) {
      throw new AppError("User id is required", 400);
    }

    if (authUser.role === Role.ADMIN || authUser.id === targetId) {
      return next();
    }

    if (authUser.role === Role.BANCA) {
      // Un usuario BANCA puede ver multiplicadores permitidos para cualquier usuario de su misma banca
      const target = await prisma.user.findUnique({
        where: { id: targetId },
        select: { bancaId: true, ventana: { select: { bancaId: true } } }
      });
      if (!target) {
        throw new AppError("Usuario no encontrado", 404, "USER_NOT_FOUND");
      }
      
      const targetBancaId = target.bancaId || target.ventana?.bancaId;
      const actorBancaId = (req as any).bancaContext?.bancaId || authUser.bancaId;
      if (targetBancaId !== actorBancaId) {
        throw new AppError("Solo puedes consultar usuarios de tu propia banca", 403);
      }
      return next();
    }

    if (authUser.role !== Role.VENTANA) {
      throw new AppError("Forbidden", 403);
    }

    const actor = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { ventanaId: true },
    });

    if (!actor?.ventanaId) {
      throw new AppError(
        "El usuario VENTANA no tiene una ventana asignada",
        403,
        "NO_VENTANA"
      );
    }

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { role: true, ventanaId: true },
    });

    if (!target) {
      throw new AppError("Usuario no encontrado", 404, "USER_NOT_FOUND");
    }

    if (target.role !== Role.VENDEDOR || target.ventanaId !== actor.ventanaId) {
      throw new AppError(
        "Solo puedes gestionar usuarios vendedores de tu ventana",
        403,
        "FORBIDDEN"
      );
    }

    next();
  },
  validateParams(getAllowedMultipliersParamsSchema),
  validateQuery(getAllowedMultipliersQuerySchema),
  UserController.getAllowedMultipliers
);

// GET /api/v1/users/:id/allowed-multipliers-batch
router.get(
  "/:id/allowed-multipliers-batch",
  restrictToAdminSelfOrVentanaVendor,
  validateParams(getAllowedMultipliersBatchParamsSchema),
  validateQuery(getAllowedMultipliersBatchQuerySchema),
  UserController.getAllowedMultipliersBatch
);

export default router;
