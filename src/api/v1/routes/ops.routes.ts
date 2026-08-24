import { Router, Request, Response, NextFunction } from 'express';
import { OpsController } from '../controllers/ops.controller';

const router = Router();
const OPS_SECRET = process.env.OPS_SECRET || 'ops-backend-secret-key-2026';

// Middleware de autenticación interna para Ops
const protectOps = (req: Request, res: Response, next: NextFunction): void => {
  const secretHeader = req.headers['x-ops-secret'];
  if (!secretHeader || secretHeader !== OPS_SECRET) {
    res.status(401).json({ success: false, error: 'Acceso no autorizado a operaciones de soporte.' });
    return;
  }
  next();
};

router.use(protectOps);

router.post('/sorteos/action', OpsController.handleSorteoAction);
router.post('/statements/check', OpsController.checkStatements);
router.post('/statements/fix', OpsController.fixStatements);
router.post('/acopio/rebuild', OpsController.auditAndRebuildAcopio);

export default router;
