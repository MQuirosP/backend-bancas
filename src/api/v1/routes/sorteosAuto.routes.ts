// src/api/v1/routes/sorteosAuto.routes.ts
import { Router } from 'express';
import { SorteosAutoController } from '../controllers/sorteosAuto.controller';
import { protect } from '../../../middlewares/auth.middleware';
import { requireAdmin } from '../../../middlewares/roleGuards.middleware';
import { validateBody } from '../../../middlewares/validate.middleware';
import { UpdateSorteosAutoConfigSchema } from '../validators/sorteosAuto.validator';

const router = Router();

// Todas las rutas requieren autenticación
router.use(protect);

// Configuración (solo ADMIN)
router.get('/auto-config', requireAdmin, SorteosAutoController.getConfig);
router.patch(
  '/auto-config',
  requireAdmin,
  validateBody(UpdateSorteosAutoConfigSchema),
  SorteosAutoController.updateConfig
);

// Health check (todos los autenticados pueden ver)
router.get('/auto-status', SorteosAutoController.getHealthStatus);

// Ejecución manual (solo ADMIN, para testing)
router.post('/auto-open/execute', requireAdmin, SorteosAutoController.executeAutoOpen);
router.post('/auto-create/execute', requireAdmin, SorteosAutoController.executeAutoCreate);
router.post('/auto-close/execute', requireAdmin, SorteosAutoController.executeAutoClose);

export default router;

