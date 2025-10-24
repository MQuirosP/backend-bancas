import { z } from 'zod'

// Helpers reutilizables
const emptyToUndef = (v: unknown) =>
  v == null || (typeof v === 'string' && v.trim() === '') ? undefined : v

const emailOptional = z.preprocess(
  emptyToUndef,
  z.string().trim().toLowerCase().email('Correo inválido').nullable().optional()
)

// Teléfono opcional: acepta variantes con separadores. El middleware de Prisma lo normaliza.
const phoneOptional = z.preprocess(
  emptyToUndef,
  z
    .string()
    .trim()
    .max(32, 'Máximo 32 caracteres') // margen cómodo si viene con separadores
    .nullable()
    .optional()
    .refine(
      (v) => !v || /^\D*\d{3}\D*\d{4}\D*\d{4}\D*$/.test(v),
      'Formato de teléfono inválido'
    )
)

export const createUserSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    email: emailOptional,
    phone: phoneOptional,
    username: z.string().trim().min(3).max(32),
    password: z.string().min(8),
    role: z.enum(['ADMIN', 'VENTANA', 'VENDEDOR']).optional(),
    ventanaId: z.uuid('ventanaId inválido').nullable().optional(), // requerido condicional abajo
    code: z
      .string()
      .trim()
      .min(2)
      .max(32)
      .optional(),
    isActive: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    const role = val.role ?? 'VENTANA'
    if (role !== 'ADMIN') {
      // Para no romper si viene '', conviértelo a null en un preprocess si lo deseas,
      // aquí solo exige presencia válida cuando no es ADMIN:
      if (!val.ventanaId || typeof val.ventanaId !== 'string' || val.ventanaId.trim().length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['ventanaId'],
          message: 'Selecciona una ventana',
        })
      }
    }
  })
  .strict()

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    email: emailOptional,
    phone: phoneOptional,
    username: z.string().trim().min(3).max(32).optional(),
    password: z.string().min(8).optional(),
    role: z.enum(['ADMIN', 'VENTANA', 'VENDEDOR']).optional(),
    ventanaId: z
      .uuid('ventanaId inválido')
      .nullable()
      .optional(),
    isActive: z.boolean().optional(),
    code: z.string().trim().min(2).max(32).nullable().optional(),
  })
  .superRefine((val, ctx) => {
    // Si cambian role en update, validamos la coherencia con ventanaId
    if (val.role && val.role !== 'ADMIN') {
      if (!val.ventanaId || `${val.ventanaId}`.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ventanaId'],
          message: 'Selecciona una ventana',
        })
      }
    }
    if (val.role === 'ADMIN') {
      // En ADMIN permitimos ventanaId null/undefined; si viene string vacía, la tratamos como null en el servicio.
    }
  })
  .strict()

export const listUsersQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    role: z.enum(['ADMIN', 'VENTANA', 'VENDEDOR']).optional(),
    search: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v && v.length > 0 ? v : undefined)),
  })
  .strict()
