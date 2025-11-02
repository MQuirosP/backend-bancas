import { z } from 'zod';
import { validateQuery } from '../../../middlewares/validate.middleware';

/**
 * Validadores Zod para módulo de Cierre Operativo
 */

// Schema base para parámetros comunes
const BaseCierreQuerySchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato debe ser YYYY-MM-DD')
    .describe('Fecha inicio (YYYY-MM-DD)'),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato debe ser YYYY-MM-DD')
    .describe('Fecha fin (YYYY-MM-DD)'),
  ventanaId: z
    .string()
    .uuid('ventanaId debe ser UUID válido')
    .optional()
    .describe('ID de ventana (opcional para ADMIN)'),
  scope: z
    .enum(['mine', 'all'])
    .optional()
    .default('all')
    .describe('Alcance: mine (mi ventana) o all (global)'),
});

/**
 * Validador para GET /api/v1/cierres/weekly
 */
export const CierreWeeklyQuerySchema = BaseCierreQuerySchema.strict();

export const validateCierreWeeklyQuery = validateQuery(CierreWeeklyQuerySchema);

/**
 * Validador para GET /api/v1/cierres/by-seller
 */
export const CierreBySellerQuerySchema = BaseCierreQuerySchema.extend({
  top: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Límite de vendedores (1-100)'),
  orderBy: z
    .enum(['totalVendida', 'ganado', 'netoDespuesComision'])
    .optional()
    .default('totalVendida')
    .describe('Campo de ordenamiento'),
}).strict();

export const validateCierreBySellerQuery = validateQuery(
  CierreBySellerQuerySchema
);

/**
 * Validador para GET /api/v1/cierres/export.xlsx
 */
export const CierreExportQuerySchema = BaseCierreQuerySchema.extend({
  view: z
    .enum(['total', '80', '85', '90', '92', '200', 'seller'])
    .describe('Vista a exportar: total, bandas (80/85/90/92/200) o seller'),
  top: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Límite de vendedores (solo para view=seller)'),
  orderBy: z
    .enum(['totalVendida', 'ganado', 'netoDespuesComision'])
    .optional()
    .default('totalVendida')
    .describe('Campo de ordenamiento (solo para view=seller)'),
}).strict();

export const validateCierreExportQuery = validateQuery(CierreExportQuerySchema);

/**
 * Validación personalizada de rango de fechas
 * Asegura que 'to' >= 'from' y que no exceda un máximo (ej: 90 días)
 */
export function validateDateRange(from: string, to: string): void {
  const fromDate = new Date(from);
  const toDate = new Date(to);

  if (toDate < fromDate) {
    throw new Error('La fecha "to" debe ser mayor o igual a "from"');
  }

  const daysDiff = Math.ceil(
    (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24)
  );

  if (daysDiff > 90) {
    throw new Error('El rango de fechas no puede exceder 90 días');
  }
}
