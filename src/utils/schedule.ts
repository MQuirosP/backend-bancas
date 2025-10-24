export type DrawSchedule = {
  frequency?: 'diario' | 'semanal' | 'personalizado'
  times?: string[]              // "HH:MM"
  daysOfWeek?: number[]         // 0..6 (0=Domingo)
}

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
  const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
  const atTime = (base: Date, hhmm: string) => {
    const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10))
    const d = new Date(base)
    d.setSeconds(0, 0)
    d.setHours(isNaN(h) ? 0 : h, isNaN(m) ? 0 : m, 0, 0)
    return d
  }

  const from = new Date(start); from.setSeconds(0,0)
  const to = addDays(from, days)

  const out: Array<{ scheduledAt: Date; name: string }> = []
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 0, 0, 0, 0)

  if (times.length === 0) return out

  while (cursor <= to && out.length < limit) {
    const dow = cursor.getDay()
    const includeDay =
      frequency === 'diario'
        ? true
        : frequency === 'semanal'
          ? daysOfWeek.includes(dow)
          : true // personalizado -> por ahora igual que diario (ajustable)

    if (includeDay) {
      for (const t of times) {
        const dt = atTime(cursor, t)
        if (dt >= from && dt <= to) {
          out.push({
            scheduledAt: dt,
            name: `${loteriaName} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`,
          })
          if (out.length >= limit) break
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1)
    cursor.setHours(0,0,0,0)
  }

  out.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
  return out
}
