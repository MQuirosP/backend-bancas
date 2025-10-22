<!-- markdownlint-disable MD041 -->

## v1.0.0-rc5 — Backend & Sorteos polish

### Changes

- Update/PUT Sorteos: ahora **solo** permite reprogramar `scheduledAt` (val. Zod + service/repository).
- Evaluate Sorteo: soporte para `extraMultiplierId` (REVENTADO) + `extraOutcomeCode` neutral; snapshot de `extraMultiplierX`.
- List Sorteos: filtro `search` por nombre, ganador o nombre de lotería.
- Validaciones centralizadas (Zod) y errores consistentes.
- ActivityLog: trazabilidad en create/update/open/close/evaluate/delete.
- Logs estructurados y mensajes de error más claros.
- Endpoints hardenizados (status y relaciones no modificables fuera de evaluate).

### API

- `PUT /api/v1/sorteos/:id` → reprogramar `scheduledAt`.
- `PATCH /api/v1/sorteos/:id/evaluate` → `winningNumber`, `extraMultiplierId?`, `extraOutcomeCode?`.
- `GET /api/v1/sorteos?search=` → búsqueda por nombre/ganador/lotería.

### Notes

- SemVer: prerelease `-rc5`.
- Migraciones Prisma aplicadas automáticamente en deploy (si corresponde).
