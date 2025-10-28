import { z } from "zod";

/**
 * Schema para parámetro ID de pago en URL
 */
export const TicketPaymentIdParamSchema = z.object({
  id: z.uuid("id inválido (UUID)"),
}).strict();

/**
 * Schema para crear un pago de tiquete (total o parcial)
 */
export const CreatePaymentSchema = z.object({
  ticketId: z.uuid("ticketId inválido (UUID requerido)"),
  amountPaid: z.coerce
    .number()
    .positive("amountPaid debe ser > 0"),
  method: z
    .enum(['cash', 'check', 'transfer', 'system'])
    .optional()
    .default('cash'),
  notes: z.string().trim().max(300, "notes máximo 300 caracteres").optional(),
  isFinal: z.boolean().optional().default(false),
  idempotencyKey: z
    .string()
    .min(8, "idempotencyKey debe tener al menos 8 caracteres")
    .max(100, "idempotencyKey máximo 100 caracteres")
    .optional(),
  ventanaId: z.string().trim().optional(),
}).strict();

export type CreatePaymentInput = z.infer<typeof CreatePaymentSchema>;

/**
 * Schema para actualizar un pago (marcar como final, agregar notas)
 */
export const UpdatePaymentSchema = z.object({
  isFinal: z.boolean().optional(),
  notes: z.string().trim().max(300, "notes máximo 300 caracteres").optional(),
}).strict();

export type UpdatePaymentInput = z.infer<typeof UpdatePaymentSchema>;

/**
 * Schema para listar pagos con filtros y paginación
 * Fechas: date (today|yesterday|week|month|year|range) + fromDate/toDate (YYYY-MM-DD) cuando date=range
 */
export const ListPaymentsQuerySchema = z.object({
  // Paginación
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),

  // Filtros
  ticketId: z.string().uuid().optional(),
  ventanaId: z.string().uuid().optional(),
  vendedorId: z.string().uuid().optional(),
  status: z.enum(['pending', 'completed', 'reversed', 'partial']).optional(),

  // Filtros de fecha (STANDARDIZADO - mismo patrón que Venta/Dashboard/Tickets)
  date: z.enum(['today', 'yesterday', 'week', 'month', 'year', 'range']).optional().default('today'),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

  // Ordenamiento
  sortBy: z.enum(['createdAt', 'amountPaid', 'updatedAt']).optional().default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
}).strict();

export type ListPaymentsQuery = z.infer<typeof ListPaymentsQuerySchema>;
