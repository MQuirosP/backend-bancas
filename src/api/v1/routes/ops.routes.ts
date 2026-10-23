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
router.post('/tickets/preview', OpsController.previewTickets);
router.post('/tickets/cancel', OpsController.cancelTickets);
router.post('/vendor/bancas', OpsController.listBancas);
router.post('/vendor/ventanas', OpsController.listVentanas);
router.post('/vendor/search', OpsController.searchVendors);
router.post('/vendor/audit', OpsController.getVendorAudit);
router.post('/vendor/transfer', OpsController.transferVendor);
router.post('/vendor/adjust-balance', OpsController.adjustVendorBalance);

// Redis Keys Operations
router.post('/redis/ventanas', OpsController.listRedisVentanas);
router.post('/redis/banca/keys', OpsController.listBancaRedisKeys);
router.post('/redis/banca/delete', OpsController.deleteBancaRedisKeys);
router.post('/redis/ventana/keys', OpsController.listVentanaRedisKeys);
router.post('/redis/ventana/delete', OpsController.deleteVentanaRedisKeys);
router.post('/redis/vendors', OpsController.listRedisVendors);
router.post('/redis/vendor/keys', OpsController.listVendorRedisKeys);
router.post('/redis/vendor/delete', OpsController.deleteVendorRedisKeys);

export default router;
