# v1.0.0-rc8 — Idempotencia de Sorteos y UTC

Cambios clave:
- Única `(loteriaId, scheduledAt)` en `Sorteo` para impedir duplicados.
- Cómputo de ocurrencias y comparaciones en UTC; utilidades en `src/utils/datetime.ts`.
- Seed idempotente que respeta el subset `scheduledDates` enviado por UI.
- Respuesta detallada del seed: `created`, `skipped`, `alreadyExists`, `processed`.
- Dedupe robusto: `createMany(skipDuplicates)` + manejo de P2002/23505.

Acciones recomendadas:
- Limpiar duplicados existentes antes de aplicar la migración.
- Validar preview/seed antes y después de medianoche con el mismo set (segunda corrida sin `created`).
- Probar ejecución concurrente de seed sobre el mismo subset.

Archivos relevantes:
- Prisma schema/migración: `src/prisma/schema.prisma`, `src/prisma/migrations/20251026215000_add_unique_sorteo_loteria_scheduledAt/migration.sql`
- Utils UTC: `src/utils/datetime.ts`, `src/utils/schedule.ts`
- Lotería: `src/api/v1/services/loteria.service.ts`, `src/api/v1/controllers/loteria.controller.ts`, `src/api/v1/validators/loteria.validator.ts`
- Repositorio: `src/repositories/sorteo.repository.ts`
