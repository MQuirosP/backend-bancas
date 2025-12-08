// src/api/v1/routes/accountStatementSettlement.routes.ts
import { Router } from 'express';
import { AccountStatementSettlementController } from '../controllers/accountStatementSettlement.controller';
import { protect } from '../../../middlewares/auth.middleware';
import { requireAdmin } from '../../../middlewares/roleGuards.middleware';
import { validateBody } from '../../../middlewares/validate.middleware';
import { UpdateAccountStatementSettlementConfigSchema } from '../validators/accountStatementSettlement.validator';

const router = Router();

// Todas las rutas requieren autenticación
router.use(protect);

// Configuración (solo ADMIN)
router.get('/auto-config', requireAdmin, AccountStatementSettlementController.getConfig);
router.patch(
  '/auto-config',
  requireAdmin,
  validateBody(UpdateAccountStatementSettlementConfigSchema),
  AccountStatementSettlementController.updateConfig
);

// Health check (todos los autenticados pueden ver)
router.get('/auto-status', AccountStatementSettlementController.getHealthStatus);

// Ejecución manual (solo ADMIN, para testing)
router.post('/execute', requireAdmin, AccountStatementSettlementController.executeSettlement);

export default router;

