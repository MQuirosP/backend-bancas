export type DrawSchedule = {
  frequency?: 'diario' | 'semanal' | 'personalizado'
  times?: string[]              // "HH:MM" en hora local de Costa Rica (GMT-6)
  daysOfWeek?: number[]         // 0..6 (0=Domingo)
}

import { atLocalTime, addLocalDays, startOfLocalDay } from './datetime'

export function computeOccurrences(params: {
  loteriaName: string
  schedule: DrawSchedule
  start: Date
  days: number
  limit?: number
}) {
  const { loteriaName, schedule, start, days, limit = 500 } = params
  const frequency = schedule.frequency ?? 'diario'
  const times = Array.isArray(schedule.times) ? schedule.times : []
  const daysOfWeek = Array.isArray(schedule.daysOfWeek) ? schedule.daysOfWeek : [0,1,2,3,4,5,6]

  const pad = (n: number) => String(n).padStart(2, '0')

  const from = startOfLocalDay(start)
  const to = addLocalDays(from, days)

  const out: Array<{ scheduledAt: Date; name: string }> = []
  const cursor = startOfLocalDay(from)

  if (times.length === 0) return out

  while (cursor <= to && out.length < limit) {
    const dow = cursor.getDay() // 0..6 (0=Domingo, hora local)
    const includeDay =
      frequency === 'diario'
        ? true
        : frequency === 'semanal'
          ? daysOfWeek.includes(dow)
          : true // personalizado -> por ahora igual que diario (ajustable)

    if (includeDay) {
      for (const t of times) {
        const dt = atLocalTime(cursor, t)
        if (dt >= from && dt <= to) {
          out.push({
            scheduledAt: dt,
            // IMPORTANTE: Usar la hora CONFIGURADA (t), NO la hora del Date object
            // Esto garantiza que el nombre muestre "12:55" si se configuró "12:55"
            name: `${loteriaName} ${t}`,
          })
          if (out.length >= limit) break
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1)
    cursor.setHours(0, 0, 0, 0)
  }

  out.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
  return out
}
