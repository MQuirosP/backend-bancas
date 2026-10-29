import { Router } from 'express';
import { OpsController } from '../controllers/ops.controller';
import { protectOpsHardened } from '../../../middlewares/opsAuth.middleware';
import { opsRateLimiter } from '../../../middlewares/rateLimit.middleware';
import { validateBody } from '../../../middlewares/validate.middleware';
import {
  handleSorteoActionSchema,
  querySorteosDataSchema,
  checkStatementsSchema,
  fixStatementsSchema,
  checkCierresSchema,
  acopioRebuildSchema,
  previewTicketsSchema,
  cancelTicketsSchema,
  listVentanasSchema,
  searchVendorsSchema,
  vendorAuditSchema,
  transferVendorSchema,
  adjustBalanceSchema,
  listRedisVentanasSchema,
  listRedisVendorsSchema,
  redisBancaKeysSchema,
  deleteBancaKeysSchema,
  redisVentanaKeysSchema,
  deleteVentanaKeysSchema,
  redisVendorKeysSchema,
  deleteVendorKeysSchema,
} from '../validators/ops.validator';

const router = Router();

// 1. Rate Limiting dedicado para operaciones de soporte (15 req/min)
router.use(opsRateLimiter);

// 2. Middleware de autenticación y aislamiento de red (Loopback / Timing-Safe compare / Fail-Closed)
router.use(protectOpsHardened);

// 3. Rutas de operaciones con validación de esquema Zod
router.post('/sorteos/action', validateBody(handleSorteoActionSchema), OpsController.handleSorteoAction);
router.post('/sorteos/query', validateBody(querySorteosDataSchema), OpsController.querySorteosData);
router.post('/statements/check', validateBody(checkStatementsSchema), OpsController.checkStatements);
router.post('/statements/fix', validateBody(fixStatementsSchema), OpsController.fixStatements);
router.post('/cierres/check', validateBody(checkCierresSchema), OpsController.checkCierres);
router.post('/acopio/rebuild', validateBody(acopioRebuildSchema), OpsController.auditAndRebuildAcopio);
router.post('/tickets/preview', validateBody(previewTicketsSchema), OpsController.previewTickets);
router.post('/tickets/cancel', validateBody(cancelTicketsSchema), OpsController.cancelTickets);
router.post('/vendor/bancas', OpsController.listBancas);
router.post('/vendor/ventanas', validateBody(listVentanasSchema), OpsController.listVentanas);
router.post('/vendor/search', validateBody(searchVendorsSchema), OpsController.searchVendors);
router.post('/vendor/audit', validateBody(vendorAuditSchema), OpsController.getVendorAudit);
router.post('/vendor/transfer', validateBody(transferVendorSchema), OpsController.transferVendor);
router.post('/vendor/adjust-balance', validateBody(adjustBalanceSchema), OpsController.adjustVendorBalance);

// Redis Keys Operations
router.post('/redis/ventanas', validateBody(listRedisVentanasSchema), OpsController.listRedisVentanas);
router.post('/redis/banca/keys', validateBody(redisBancaKeysSchema), OpsController.listBancaRedisKeys);
router.post('/redis/banca/delete', validateBody(deleteBancaKeysSchema), OpsController.deleteBancaRedisKeys);
router.post('/redis/ventana/keys', validateBody(redisVentanaKeysSchema), OpsController.listVentanaRedisKeys);
router.post('/redis/ventana/delete', validateBody(deleteVentanaKeysSchema), OpsController.deleteVentanaRedisKeys);
router.post('/redis/vendors', validateBody(listRedisVendorsSchema), OpsController.listRedisVendors);
router.post('/redis/vendor/keys', validateBody(redisVendorKeysSchema), OpsController.listVendorRedisKeys);
router.post('/redis/vendor/delete', validateBody(deleteVendorKeysSchema), OpsController.deleteVendorRedisKeys);

export default router;
