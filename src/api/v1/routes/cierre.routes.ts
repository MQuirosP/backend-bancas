import { Router } from 'express';
import { protect, restrictTo } from '../../../middlewares/auth.middleware';
import { CierreController } from '../controllers/cierre.controller';
import {
  validateCierreWeeklyQuery,
  validateCierreBySellerQuery,
  validateCierreExportQuery,
} from '../validators/cierre.validator';
import { Role } from '@prisma/client';

const router = Router();

/**
 * Rutas para módulo de Cierre Operativo
 * Requiere autenticación y roles ADMIN o VENTANA
 */

// Middleware de autenticación (todas las rutas)
router.use(protect);

// Middleware de autorización (solo ADMIN y VENTANA)
router.use(restrictTo(Role.ADMIN, Role.VENTANA));

/**
 * GET /api/v1/cierres/weekly
 * Cierre semanal agregado por banda, lotería y turno
 *
 * Query params:
 * - from: YYYY-MM-DD (required)
 * - to: YYYY-MM-DD (required)
 * - ventanaId: UUID (optional, ADMIN only)
 * - scope: 'mine' | 'all' (default: 'all')
 *
 * RBAC:
 * - ADMIN: puede ver todas las ventanas (scope=all) o una específica
 * - VENTANA: solo su ventana (scope=mine forzado)
 */
router.get('/weekly', validateCierreWeeklyQuery, CierreController.getWeekly);

/**
 * GET /api/v1/cierres/by-seller
 * Cierre agregado por vendedor
 *
 * Query params:
 * - from: YYYY-MM-DD (required)
 * - to: YYYY-MM-DD (required)
 * - ventanaId: UUID (optional, ADMIN only)
 * - scope: 'mine' | 'all' (default: 'all')
 * - top: number (optional, límite de vendedores)
 * - orderBy: 'totalVendida' | 'ganado' | 'netoDespuesComision' (default: 'totalVendida')
 *
 * RBAC:
 * - ADMIN: puede ver todas las ventanas o una específica
 * - VENTANA: solo vendedores de su ventana
 */
router.get(
  '/by-seller',
  validateCierreBySellerQuery,
  CierreController.getBySeller
);

/**
 * GET /api/v1/cierres/export.xlsx
 * Exporta cierre a Excel
 *
 * Query params:
 * - from: YYYY-MM-DD (required)
 * - to: YYYY-MM-DD (required)
 * - ventanaId: UUID (optional, ADMIN only)
 * - scope: 'mine' | 'all' (default: 'all')
 * - view: 'total' | '80' | '85' | '90' | '92' | '200' | 'seller' (required)
 * - top: number (optional, solo para view=seller)
 * - orderBy: 'totalVendida' | 'ganado' | 'netoDespuesComision' (solo para view=seller)
 *
 * RBAC:
 * - ADMIN: puede exportar todas las ventanas o una específica
 * - VENTANA: solo su ventana
 *
 * Response:
 * - Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
 * - Content-Disposition: attachment; filename=cierre-YYYY-MM-DD-YYYY-MM-DD.xlsx
 */
router.get(
  '/export.xlsx',
  validateCierreExportQuery,
  CierreController.exportXLSX
);

export default router;
