import { z } from 'zod';

export const listAccountsQuerySchema = z.object({
  ownerType: z.enum(['BANCA', 'VENTANA', 'VENDEDOR']).optional(),
  ownerId: z.string().optional(),
  isActive: z.enum(['true', 'false']).transform(v => v === 'true').optional(),
  page: z.string().default('1').transform(v => parseInt(v, 10)),
  pageSize: z.string().default('20').transform(v => parseInt(v, 10)),
});

// UUID validation helper
const uuidSchema = z.uuid('Invalid account ID format');

export const getAccountDetailsParamsSchema = z.object({
  accountId: uuidSchema,
});

export const getBalanceParamsSchema = z.object({
  accountId: uuidSchema,
});

export const listLedgerEntriesQuerySchema = z.object({
  accountId: uuidSchema,
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
  accountId: uuidSchema,
});

export const getDailySnapshotsQuerySchema = z.object({
  accountId: uuidSchema,
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

export const createPaymentDocumentSchema = z.object({
  fromAccountId: uuidSchema,
  toAccountId: uuidSchema,
  amount: z.number().positive(),
  docNumber: z.string().min(1),
  date: z.string().transform(v => new Date(v)),
  description: z.string().optional(),
  receiptUrl: z.string().url().optional(),
  requestId: z.string().optional(),
});

export const createAccountSchema = z.object({
  ownerType: z.enum(['BANCA', 'VENTANA', 'VENDEDOR']),
  ownerId: z.string().min(1),
  currency: z.string().default('CRC'),
  initialBalance: z.number().optional(),
  initialBalanceNote: z.string().optional(),
});

export const closeDaySchema = z.object({
  date: z.string().transform(v => new Date(v)),
});

export const getDailySummarySchema = z.object({
  accountId: uuidSchema,
  date: z.string().transform(v => new Date(v)),
});

export const calculateMayorizationSchema = z.object({
  accountId: uuidSchema,
  fromDate: z.string().transform(v => new Date(v)),
  toDate: z.string().transform(v => new Date(v)),
  includeDesglose: z.enum(['true', 'false']).transform(v => v === 'true').optional(),
});

export const getMayorizationHistorySchema = z.object({
  period: z.enum(['today', 'yesterday', 'week', 'month', 'year', 'range']).optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  ownerType: z.enum(['VENTANA', 'VENDEDOR']).optional(),
  ownerId: z.string().uuid().optional(),
  debtStatus: z.enum(['CXC', 'CXP', 'BALANCE']).optional(),
  isSettled: z.enum(['true', 'false']).transform(v => v === 'true').optional(),
  page: z.string().default('1').transform(v => parseInt(v, 10)),
  pageSize: z.string().default('20').transform(v => parseInt(v, 10)),
  orderBy: z.enum(['date', 'debtAmount', 'netOperative']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export const settleMayorizationSchema = z.object({
  mayorizationId: uuidSchema,
  amount: z.number().positive('Amount must be positive'),
  settlementType: z.enum(['PAYMENT', 'COLLECTION']),
  date: z.string().transform(v => new Date(v)),
  reference: z.string().min(1, 'Reference is required'),
  note: z.string().optional(),
  requestId: z.string().optional(),
});
