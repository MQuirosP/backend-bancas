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
} from "../validators/user.validator";
import { z } from "zod";
import { Role } from "@prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";

const router = Router();

const idParamSchema = z.object({ id: z.uuid("Invalid user id") });

// ADMIN-only
router.post(
  "/",
  protect,
  restrictTo(Role.ADMIN, Role.VENTANA),
  validateBody(createUserSchema),
  UserController.create
);
router.patch(
  "/:id",
  protect,
  restrictToAdminSelfOrVentanaVendor,
  validateParams(idParamSchema),
  validateBody(updateUserSchema),
  UserController.update
);
router.delete(
  "/:id",
  protect,
  restrictTo(Role.ADMIN, Role.VENTANA),
  validateParams(idParamSchema),
  UserController.remove
);
router.patch(
  "/:id/restore",
  protect,
  restrictTo(Role.ADMIN, Role.VENTANA),
  validateParams(idParamSchema),
  UserController.restore
);

// Change password (permite que el usuario autenticado cambie su propia contraseña)
router.put(
  "/me/password",
  protect,
  validateBody(ChangePasswordSchema),
  UserController.changePassword
);

// List & Get (list admin-only; get self allowed if necesitas, por ahora admin)
router.get(
  "/",
  protect,
  restrictTo(Role.ADMIN, Role.VENTANA),
  validateQuery(listUsersQuerySchema),
  UserController.list
);
router.get(
  "/:id",
  protect,
  restrictToAdminSelfOrVentanaVendor,
  validateParams(idParamSchema),
  UserController.getById
);

// GET /api/v1/users/:userId/allowed-multipliers
router.get(
  "/:userId/allowed-multipliers",
  protect,
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

export default router;
