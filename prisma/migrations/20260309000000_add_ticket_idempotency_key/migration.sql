-- ============================================================================
-- MIGRACIÓN: Idempotency key a nivel DB para Ticket
-- SEGURIDAD: Solo ADD COLUMN nullable + CREATE UNIQUE INDEX CONCURRENTLY
--            No modifica filas existentes. Tickets anteriores quedan con NULL.
-- FECHA: 2026-03-09
-- APLICAR: manualmente vía psql, luego marcar con prisma migrate resolve --applied
-- ============================================================================

-- 1) Columna nullable: tickets existentes no se ven afectados
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

-- 2) Índice único PARCIAL (solo filas donde NO es NULL)
--    CONCURRENTLY: no bloquea la tabla en producción
--    Nota: ejecutar FUERA de transacción (directamente en psql, no vía migrate deploy)
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Ticket_idempotencyKey_key"
  ON "Ticket" ("idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;

-- ============================================================================
-- ROLLBACK (si se necesita revertir)
-- ============================================================================
-- DROP INDEX IF EXISTS "Ticket_idempotencyKey_key";
-- ALTER TABLE "Ticket" DROP COLUMN IF EXISTS "idempotencyKey";
