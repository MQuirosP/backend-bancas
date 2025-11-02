import { Router } from 'express';
import ActivityLogController from '../controllers/activityLog.controller';
import { protect, restrictTo } from '../../../middlewares/auth.middleware';
import {
  validateParams,
  validateQuery,
  validateBody,
} from '../../../middlewares/validate.middleware';
import {
  listActivityLogsQuerySchema,
  getActivityLogByIdParamSchema,
  getByUserParamSchema,
  getByTargetParamSchema,
  getByActionParamSchema,
  cleanupLogsBodySchema,
} from '../validators/activityLog.validator';
import { Role } from '@prisma/client';

const router = Router();

// Todos los endpoints requieren autenticación y solo ADMIN puede acceder
router.use(protect);
router.use(restrictTo(Role.ADMIN));

// GET /api/v1/activity-logs - Lista paginada de todos los logs
router.get(
  '/',
  validateQuery(listActivityLogsQuerySchema),
  ActivityLogController.list
);

// GET /api/v1/activity-logs/:id - Obtener un log específico
router.get(
  '/:id',
  validateParams(getActivityLogByIdParamSchema),
  ActivityLogController.getById
);

// GET /api/v1/activity-logs/user/:userId - Logs de un usuario específico
router.get(
  '/user/:userId',
  validateParams(getByUserParamSchema),
  ActivityLogController.getByUser
);

// GET /api/v1/activity-logs/target/:targetType/:targetId - Logs de un entity específico
router.get(
  '/target/:targetType/:targetId',
  validateParams(getByTargetParamSchema),
  ActivityLogController.getByTarget
);

// GET /api/v1/activity-logs/action/:action - Logs de una acción específica
router.get(
  '/action/:action',
  validateParams(getByActionParamSchema),
  ActivityLogController.getByAction
);

// POST /api/v1/activity-logs/cleanup - Limpiar logs antiguos
router.post(
  '/cleanup',
  validateBody(cleanupLogsBodySchema),
  ActivityLogController.cleanup
);

export default router;
