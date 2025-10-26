# Idempotencia de Sorteos y Normalización UTC (rc8)

Objetivo: garantizar que no se creen sorteos duplicados por Lotería/fecha-hora, respetar subsets enviados por el frontend y operar de forma reproducible en UTC.

## Cambios Clave

- Restricción única en BD: `@@unique([loteriaId, scheduledAt])` en el modelo `Sorteo`.
- Utilidades UTC en `src/utils/datetime.ts`:
  - `toUtcDate`, `startOfUtcDay`, `addUtcDays`, `atUtcTime`, `sameInstant`, `formatIsoUtc`.
- `computeOccurrences` (src/utils/schedule.ts) ahora genera ocurrencias en UTC (getUTCDay, setUTCHours).
- Repo de Sorteo: `bulkCreateIfMissing` usa `createMany({ skipDuplicates: true })`, deduplicación por timestamp y buffer temporal ±60s.
- Servicio de Lotería: `seedSorteosFromRules` honra el subset opcional `scheduledDates` del body (por timestamp exacto) y respeta dry-run.

## API y Contratos

### Preview de agenda

GET `/api/v1/loterias/:id/preview_schedule?start&days&limit`

- Responde lista de `{ scheduledAt: ISO-UTC, name }` generada en UTC.

### Seed idempotente

POST `/api/v1/loterias/:id/seed_sorteos?start&days&dryRun`

Body opcional:

```json
{ "scheduledDates": ["2025-01-20T12:55:00.000Z", "2025-01-20T16:30:00.000Z"] }
```

Respuesta (dryRun=false):

```json
{
  "created": ["..."],
  "skipped": ["..."],
  "alreadyExists": ["..."],
  "processed": ["..."]
}
```

Respuesta (dryRun=true):

```json
{
  "created": [],
  "skipped": [],
  "alreadyExists": [],
  "preview": [{"scheduledAt":"...","name":"..."}],
  "processedSubset": ["..."]
}
```

## Notas de Implementación

- La deduplicación en memoria y BD se hace por `Date.getTime()` (ms desde epoch) para evitar divergencias por formato.
- Los rangos de consulta utilizan un pequeño buffer de ±60s para cubrir fronteras (p. ej. medianoche/local vs UTC).
- Bajo concurrencia, se valida post-inserción para computar `created` reales (los perdidos se reportan en `skipped`).

## Migración

Archivo: `src/prisma/migrations/20251026215000_add_unique_sorteo_loteria_scheduledAt/migration.sql`

```
CREATE UNIQUE INDEX IF NOT EXISTS "Sorteo_loteriaId_scheduledAt_key"
  ON "Sorteo" ("loteriaId", "scheduledAt");
```

Si ya existen duplicados, la migración fallará: limpiar duplicados antes de `deploy:db`.

