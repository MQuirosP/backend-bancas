// src/common/utils/phone.util.ts

/**
 * Quita TODO lo que no sean dígitos. Si queda vacío, retorna null.
 * Ej.: " (506) 8888-8888 " -> "50688888888"
 */
export function normalizePhone(input?: string | null): string | null {
  if (!input) return null
  const digits = input.replace(/\D/g, '')
  return digits.length ? digits : null
}

/**
 * Valida "teléfono tipo CR" permisivo en entrada (para DTOs):
 * Acepta variantes con separadores porque normalizamos antes de guardar.
 * Ej. "(506) 8888-8888", "506 8888 8888", "506-8888-8888".
 */
export function isLooseCRPhone(input?: string | null): boolean {
  if (!input) return true // opcional
  return /^\D*\d{3}\D*\d{4}\D*\d{4}\D*$/.test(input)
}

/**
 * (Opcional) Valida que el teléfono normalizado tenga exactamente 11 dígitos (ej. CR: 506 + 8).
 * Úsalo solo si quieres exigir longitud fija tras normalizar.
 */
export function isNormalizedCRPhone(digits?: string | null): boolean {
  if (!digits) return true // opcional
  return /^\d{11}$/.test(digits) // 3 prefijo + 8 número
}
