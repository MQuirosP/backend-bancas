import { z } from 'zod';

export const listAccountsQuerySchema = z.object({
  ownerType: z.enum(['BANCA', 'VENTANA', 'VENDEDOR']).optional(),
  ownerId: z.string().optional(),
  isActive: z.enum(['true', 'false']).transform(v => v === 'true').optional(),
  page: z.string().default('1').transform(v => parseInt(v, 10)),
  pageSize: z.string().default('20').transform(v => parseInt(v, 10)),
});

export const getAccountDetailsParamsSchema = z.object({
  accountId: z.string().min(1),
});

export const getBalanceParamsSchema = z.object({
  accountId: z.string().min(1),
});

export const listLedgerEntriesQuerySchema = z.object({
  accountId: z.string().min(1),
  type: z.string().optional().transform(v => v?.split(',').filter(Boolean)),
  from: z.string().optional().transform(v => v ? new Date(v) : undefined),
  to: z.string().optional().transform(v => v ? new Date(v) : undefined),
  referenceType: z.string().optional(),
  page: z.string().default('1').transform(v => parseInt(v, 10)),
  pageSize: z.string().default('20').transform(v => parseInt(v, 10)),
  sort: z.enum(['date', 'createdAt']).default('date'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const getBalanceSummaryParamsSchema = z.object({
  accountId: z.string().min(1),
});

export const getDailySnapshotsQuerySchema = z.object({
  accountId: z.string().min(1),
  from: z.string().transform(v => new Date(v)),
  to: z.string().transform(v => new Date(v)),
});

export const addSaleEntrySchema = z.object({
  ticketId: z.string().min(1),
  amount: z.number().positive(),
  requestId: z.string().optional(),
});

export const addCommissionEntrySchema = z.object({
  saleAmount: z.number().positive(),
  commissionRate: z.number().min(0).max(1),
  ticketId: z.string().min(1),
  requestId: z.string().optional(),
});

export const addPayoutEntrySchema = z.object({
  amount: z.number().positive(),
  payoutId: z.string().min(1),
  reason: z.string().optional(),
  requestId: z.string().optional(),
});

export const createBankDepositSchema = z.object({
  date: z.string().transform(v => new Date(v)),
  docNumber: z.string().min(1),
  amount: z.number().positive(),
  bankName: z.string().optional(),
  note: z.string().optional(),
  receiptUrl: z.string().url().optional(),
  requestId: z.string().optional(),
});

export const reverseEntrySchema = z.object({
  reason: z.string().min(1),
  requestId: z.string().optional(),
});

export const createDailySnapshotSchema = z.object({
  date: z.string().transform(v => new Date(v)),
  opening: z.number(),
  debit: z.number(),
  credit: z.number(),
  closing: z.number(),
});

export const updateAccountSchema = z.object({
  isActive: z.boolean().optional(),
});
