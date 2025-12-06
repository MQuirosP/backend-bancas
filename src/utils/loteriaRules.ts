// src/lib/rules/loteriaRules.ts

export type RulesJson = {
  closingTimeBeforeDraw?: number
  minBetAmount?: number
  maxBetAmount?: number
  maxNumbersPerTicket?: number
  numberRange?: { min: number; max: number }
  allowedBetTypes?: Array<'NUMERO' | 'REVENTADO'>
  reventadoConfig?: {
    enabled: boolean
    requiresMatchingNumber?: boolean
    colors?: Array<'ROJA' | 'VERDE'>
  }
  drawSchedule?: {
    frequency?: 'diario' | 'semanal' | 'personalizado'
    times?: string[]            // "HH:MM"
    daysOfWeek?: number[]       // 0..6
  }
  autoCreateSorteos?: boolean
  display?: {
    color?: string
    icon?: string
    description?: string
    featured?: boolean
  }
  baseMultiplierX?: number
  digits?: number              // ✅ Número de dígitos del sorteo (2 para tiempos, 3 para monazos). Default: 2
  salesHours?: {
    sunday?: { start?: string; end?: string }
    monday?: { start?: string; end?: string }
    tuesday?: { start?: string; end?: string }
    wednesday?: { start?: string; end?: string }
    thursday?: { start?: string; end?: string }
    friday?: { start?: string; end?: string }
    saturday?: { start?: string; end?: string }
  }
}

// 1. Resolver multiplicador efectivo
export function resolveBaseMultiplierX(opts: {
  userOverride?: { baseMultiplierX: number } | null
  ventanaOverride?: { baseMultiplierX: number } | null
  bancaSetting?: { baseMultiplierX: number } | null
  loteriaRules?: RulesJson | null
  fallback?: number
}): number {
  const {
    userOverride, ventanaOverride, bancaSetting, loteriaRules, fallback = 90,
  } = opts

  if (userOverride?.baseMultiplierX != null) return userOverride.baseMultiplierX
  if (ventanaOverride?.baseMultiplierX != null) return ventanaOverride.baseMultiplierX
  if (bancaSetting?.baseMultiplierX != null) return bancaSetting.baseMultiplierX
  if (loteriaRules?.baseMultiplierX != null) return loteriaRules.baseMultiplierX
  return fallback
}

// 2. Resolver cutoff efectivo (minutos antes del sorteo)
export function resolveSalesCutoffMinutes(opts: {
  restrictionRuleCutoff?: number | null
  loteriaRules?: RulesJson | null
  bancaCutoff?: number | null
}): number {
  const { restrictionRuleCutoff, loteriaRules, bancaCutoff } = opts
  if (restrictionRuleCutoff != null) return restrictionRuleCutoff
  if (loteriaRules?.closingTimeBeforeDraw != null) return loteriaRules.closingTimeBeforeDraw
  return bancaCutoff ?? 5
}

// 3. Validar si un Date cae dentro de salesHours (si define)
import { getCRLocalComponents } from './businessDate'

export function isWithinSalesHours(dateUtc: Date, rules?: RulesJson | null): boolean {
  if (!rules?.salesHours) return true // sin restricción => 24h
  const cr = getCRLocalComponents(dateUtc)
  const key = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][cr.dow] as keyof NonNullable<RulesJson['salesHours']>
  const window = rules.salesHours[key]
  if (!window || (!window.start && !window.end)) return true
  const hh = String(cr.hour).padStart(2,'0')
  const mm = String(cr.minute).padStart(2,'0')
  const t = `${hh}:${mm}`
  const ge = (a?: string) => !a || t >= a
  const le = (b?: string) => !b || t <= b
  return ge(window.start) && le(window.end)
}

// 4. Validar reglas de ticket a nivel Lotería.rulesJson (rango, montos, tipos)
export function validateTicketAgainstRules(input: {
  loteriaRules?: RulesJson | null
  jugadas: Array<{ type: 'NUMERO'|'REVENTADO'; number: string; amount: number; reventadoNumber?: string }>
}): { ok: true } | { ok: false; reason: string } {
  const r = input.loteriaRules ?? {}

  if (r.numberRange) {
    const min = r.numberRange.min ?? 0
    const max = r.numberRange.max ?? 99
    for (const j of input.jugadas) {
      const n = parseInt(j.number, 10)
      if (isNaN(n) || n < min || n > max) {
        return { ok: false, reason: `Número fuera de rango (${min}–${max})` }
      }
    }
  }

  if (r.allowedBetTypes && r.allowedBetTypes.length > 0) {
    for (const j of input.jugadas) {
      if (!r.allowedBetTypes.includes(j.type)) {
        return { ok: false, reason: `Tipo de apuesta no permitido: ${j.type}` }
      }
    }
  }

  if (r.reventadoConfig?.enabled === false) {
    if (input.jugadas.some(j => j.type === 'REVENTADO')) {
      return { ok: false, reason: 'Reventado deshabilitado' }
    }
  }
  if (r.reventadoConfig?.requiresMatchingNumber) {
    for (const j of input.jugadas) {
      if (j.type === 'REVENTADO' && !j.reventadoNumber) {
        return { ok: false, reason: 'REVENTADO requiere número asociado' }
      }
    }
  }

  if (r.minBetAmount != null || r.maxBetAmount != null) {
    for (const j of input.jugadas) {
      if (r.minBetAmount != null && j.amount < r.minBetAmount) {
        return { ok: false, reason: `Monto mínimo por jugada: ${r.minBetAmount}` }
      }
      if (r.maxBetAmount != null && j.amount > r.maxBetAmount) {
        return { ok: false, reason: `Monto máximo por jugada: ${r.maxBetAmount}` }
      }
    }
  }

  if (r.maxNumbersPerTicket != null) {
    const count = input.jugadas.length
    if (count > r.maxNumbersPerTicket) {
      return { ok: false, reason: `Máximo de jugadas por ticket: ${r.maxNumbersPerTicket}` }
    }
  }

  return { ok: true }
}

// 5. Resolver digits efectivo desde rulesJson
export function resolveDigits(rules?: RulesJson | null, fallback: number = 2): number {
  if (rules?.digits != null && (rules.digits === 2 || rules.digits === 3)) {
    return rules.digits
  }
  return fallback
}
