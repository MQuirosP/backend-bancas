import { z } from 'zod';

export const handleSorteoActionSchema = z.object({
  action: z.enum(['EVALUATE', 'REVERT', 'CLOSE', 'REOPEN']),
  sorteoId: z.string().uuid('ID de sorteo inválido'),
  winningNumber: z.string().optional(),
  extraMultiplierId: z.string().uuid().nullable().optional(),
});

export const checkStatementsSchema = z.object({
  fromStr: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido (YYYY-MM-DD)').optional(),
  toStr: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido (YYYY-MM-DD)').optional(),
  bancaId: z.string().uuid('ID de banca inválido').nullable().optional(),
});

export const fixStatementsSchema = z.object({
  fromStr: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido (YYYY-MM-DD)').optional(),
  toStr: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido (YYYY-MM-DD)').optional(),
  bancaId: z.string().uuid('ID de banca inválido').nullable().optional(),
});

export const acopioRebuildSchema = z.object({
  fromStr: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido (YYYY-MM-DD)').optional(),
  toStr: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido (YYYY-MM-DD)').optional(),
  fromDateStr: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido (YYYY-MM-DD)').optional(),
  toDateStr: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido (YYYY-MM-DD)').optional(),
  bancaId: z.string().uuid('ID de banca inválido').nullable().optional(),
  executeRebuild: z.boolean().optional(),
});

export const previewTicketsSchema = z.object({
  ticketNumbers: z.array(z.string().min(1)).min(1, 'Debe especificar al menos un número de ticket'),
});

export const cancelTicketsSchema = z.object({
  ticketNumbers: z.array(z.string().min(1)).min(1, 'Debe especificar al menos un número de ticket'),
  reason: z.string().max(500).optional(),
  forceWithPayments: z.boolean().optional(),
});

export const listVentanasSchema = z.object({
  bancaId: z.string().uuid('ID de banca inválido'),
});

export const searchVendorsSchema = z.object({
  query: z.string().optional(),
  bancaId: z.string().uuid('ID de banca inválido').nullable().optional(),
});

export const vendorAuditSchema = z.object({
  vendedorId: z.string().uuid('ID de vendedor inválido'),
});

export const transferVendorSchema = z.object({
  vendedorId: z.string().uuid('ID de vendedor inválido'),
  targetBancaId: z.string().uuid('ID de banca destino inválido'),
  targetVentanaId: z.string().uuid('ID de ventana destino inválido'),
  balanceMode: z.enum(['ZERO', 'CARRY_OVER', 'CUSTOM']),
  customBalance: z.coerce.number().optional(),
  resetOriginBalance: z.boolean().optional(),
  notes: z.string().max(500).optional(),
});

export const adjustBalanceSchema = z.object({
  vendedorId: z.string().uuid('ID de vendedor inválido'),
  bancaId: z.string().uuid('ID de banca inválido'),
  targetBalance: z.coerce.number(),
  reason: z.string().max(500).optional(),
});

export const listRedisVentanasSchema = z.object({
  bancaId: z.string().uuid('ID de banca inválido').nullable().optional(),
});

export const listRedisVendorsSchema = z.object({
  query: z.string().optional(),
  bancaId: z.string().uuid('ID de banca inválido').nullable().optional(),
  ventanaId: z.string().uuid('ID de ventana inválido').nullable().optional(),
});

export const redisBancaKeysSchema = z.object({
  bancaId: z.string().uuid('ID de banca inválido'),
});

export const deleteBancaKeysSchema = z.object({
  keys: z.array(z.string()).optional(),
  bancaId: z.string().uuid('ID de banca inválido').optional(),
  deleteAll: z.boolean().optional(),
});

export const redisVentanaKeysSchema = z.object({
  ventanaId: z.string().uuid('ID de ventana inválido'),
});

export const deleteVentanaKeysSchema = z.object({
  keys: z.array(z.string()).optional(),
  ventanaId: z.string().uuid('ID de ventana inválido').optional(),
  deleteAll: z.boolean().optional(),
});

export const redisVendorKeysSchema = z.object({
  vendedorId: z.string().uuid('ID de vendedor inválido'),
});

export const deleteVendorKeysSchema = z.object({
  keys: z.array(z.string()).optional(),
  vendedorId: z.string().uuid('ID de vendedor inválido').optional(),
  deleteAll: z.boolean().optional(),
});
