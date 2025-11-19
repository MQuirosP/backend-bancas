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

// ==================== USER SETTINGS (definir antes de updateUserSchema) ====================

const bluetoothMacRegex = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/
const bluetoothMacCompactRegex = /^[0-9A-Fa-f]{8}$/

/**
 * Configuraciones de impresión para usuario/ventana
 */
const PrintSettingsSchema = z
  .object({
    name: z.string().trim().max(100).nullable().optional(),
    phone: z.string().trim().max(32).nullable().optional(),
    width: z.union([z.literal(58), z.literal(88)]).nullable().optional(), // 58mm o 88mm
    footer: z.string().trim().max(200).nullable().optional(), // Máximo 200 caracteres
    barcode: z.boolean().nullable().optional(),
    bluetoothMacAddress: z
      .string()
      .trim()
      .nullable()
      .optional()
      .refine(
        (value) => !value || bluetoothMacRegex.test(value) || bluetoothMacCompactRegex.test(value),
        'Formato inválido. Usa AA:BB:CC:DD:EE:FF o AABBCCDD'
      ),
  })
  .strict()

/**
 * Esquema completo de UserSettings
 * Incluye configuraciones de impresión y tema
 */
export const UserSettingsSchema = z
  .object({
    print: PrintSettingsSchema.optional(),
    theme: z.enum(['light', 'dark']).nullable().optional(),
  })
  .strict()

// ==================== CREATE & UPDATE SCHEMAS ====================

export const createUserSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    email: emailOptional,
    phone: phoneOptional,
    username: z.string().trim().min(3).max(32),
    password: z.string().min(6, 'La contraseña debe tener al menos 6 caracteres'),
    role: z.enum(['ADMIN', 'VENTANA', 'VENDEDOR']).optional(),
    ventanaId: z.uuid('ventanaId inválido').nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    email: emailOptional,
    phone: phoneOptional,
    username: z.string().trim().min(3).max(32).optional(),
    password: z.string().min(6, 'La contraseña debe tener al menos 6 caracteres').optional(),
    role: z.enum(['ADMIN', 'VENTANA', 'VENDEDOR']).optional(),
    ventanaId: z
      .uuid('ventanaId inválido')
      .nullable()
      .optional(),
    isActive: z.boolean().optional(),
    code: z.string().trim().min(2).max(32).nullable().optional(),
    settings: UserSettingsSchema.nullable().optional(),
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

// Parser correcto para booleanos desde query strings
const queryBoolean = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') return v;

  const s = v.toLowerCase().trim();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return undefined; // Si no es un booleano válido, undefined
}, z.boolean().optional());

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
    isActive: queryBoolean,
    _: z.string().optional(), // Para evitar caché del navegador (ignorado)
  })
  .strict()

// ==================== ADDITIONAL SETTINGS SCHEMAS ====================

/**
 * Esquema para actualizar settings (merge parcial)
 * Los campos pueden venir null o undefined; el servicio hace merge
 */
export const UpdateUserSettingsSchema = z
  .object({
    settings: UserSettingsSchema.nullable().optional(),
  })
  .strict()

/**
 * Esquema para cambiar contraseña propia
 */
export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Contraseña actual requerida'),
    newPassword: z.string().min(6, 'Nueva contraseña debe tener al menos 6 caracteres'),
  })
  .strict()
  .refine(
    (data) => data.currentPassword !== data.newPassword,
    {
      message: 'La nueva contraseña debe ser diferente a la actual',
      path: ['newPassword'],
    }
  )
