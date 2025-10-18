export function parseCorsOrigins(raw: string | undefined) {
  if (!raw || raw.trim() === '') return { allowAll: true, list: [] as string[] }

  // Si contiene "*" en cualquier posición, permitimos todo.
  if (raw.split(',').some(s => s.trim() === '*')) {
    return { allowAll: true, list: [] as string[] }
  }

  const list = raw
    .split(',')
    .map(s => s.trim())
    .map(s => s.replace(/\/+$/, '')) // quita slash final
    .filter(Boolean)

  return { allowAll: false, list }
}
