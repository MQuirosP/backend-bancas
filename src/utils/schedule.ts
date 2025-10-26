export type DrawSchedule = {
  frequency?: 'diario' | 'semanal' | 'personalizado'
  times?: string[]              // "HH:MM" (interpretado en UTC para reproducibilidad)
  daysOfWeek?: number[]         // 0..6 (0=Domingo, usando getUTCDay)
}

import { atUtcTime, addUtcDays, startOfUtcDay } from './datetime'

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

  const from = startOfUtcDay(start)
  const to = addUtcDays(from, days)

  const out: Array<{ scheduledAt: Date; name: string }> = []
  const cursor = startOfUtcDay(from)

  if (times.length === 0) return out

  while (cursor <= to && out.length < limit) {
    const dow = cursor.getUTCDay() // 0..6 (UTC)
    const includeDay =
      frequency === 'diario'
        ? true
        : frequency === 'semanal'
          ? daysOfWeek.includes(dow)
          : true // personalizado -> por ahora igual que diario (ajustable)

    if (includeDay) {
      for (const t of times) {
        const dt = atUtcTime(cursor, t)
        if (dt >= from && dt <= to) {
          out.push({
            scheduledAt: dt,
            name: `${loteriaName} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`,
          })
          if (out.length >= limit) break
        }
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1)
    cursor.setUTCHours(0,0,0,0)
  }

  out.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
  return out
}
