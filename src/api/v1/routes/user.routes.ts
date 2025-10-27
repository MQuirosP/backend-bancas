import { Router } from "express";
import UserController from "../controllers/user.controller";
import { protect, restrictTo } from "../../../middlewares/auth.middleware";
import {
  validateBody,
  validateParams,
  validateQuery,
} from "../../../middlewares/validate.middleware";
import {
  createUserSchema,
  updateUserSchema,
  listUsersQuerySchema,
} from "../validators/user.validator";
import { z } from "zod";
import { Role } from "@prisma/client";

const router = Router();

const idParamSchema = z.object({ id: z.uuid("Invalid user id") });

// ADMIN-only
router.post(
  "/",
  protect,
  restrictTo(Role.ADMIN),
  validateBody(createUserSchema),
  UserController.create
);
router.patch(
  "/:id",
  protect,
  restrictTo(Role.ADMIN),
  validateParams(idParamSchema),
  validateBody(updateUserSchema),
  UserController.update
);
router.delete(
  "/:id",
  protect,
  restrictTo(Role.ADMIN),
  validateParams(idParamSchema),
  UserController.remove
);
router.patch(
  "/:id/restore",
  protect,
  restrictTo(Role.ADMIN),
  validateParams(idParamSchema),
  UserController.restore
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
  restrictTo(Role.ADMIN),
  validateParams(idParamSchema),
  UserController.getById
);

export default router;
