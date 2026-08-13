-- ============================================================================
-- MIGRACION: Indices de performance para connection pool exhaustion
-- SEGURIDAD: Solo CREATE INDEX - NO modifica datos ni estructura de tabla
-- FECHA: 2026-02-15
-- REF: PLAN_NOCTURNO.md - Parte B (B1.1 a B1.5)
-- ============================================================================

-- B1.1 Sorteo: status + scheduledAt
-- Beneficia: evaluatedSummary filtra status IN (EVALUATED) + rango scheduledAt
CREATE INDEX IF NOT EXISTS "Sorteo_status_scheduledAt_idx"
  ON "Sorteo" ("status", "scheduledAt");

-- B1.2 Jugada: ticketId + deletedAt
-- Beneficia: jugadas filtradas por ticketId + deletedAt IS NULL (JOINs en sorteo.service)
CREATE INDEX IF NOT EXISTS "Jugada_ticketId_deletedAt_idx"
  ON "Jugada" ("ticketId", "deletedAt");

-- B1.3 Ticket: vendedorId + sorteoId + deletedAt + isActive
-- Beneficia: 6 groupBy en evaluatedSummary que filtran por esta combinacion
CREATE INDEX IF NOT EXISTS "Ticket_vendedorId_sorteoId_deletedAt_isActive_idx"
  ON "Ticket" ("vendedorId", "sorteoId", "deletedAt", "isActive");

-- B1.4 Ticket: ventanaId + businessDate + deletedAt
-- Beneficia: venta.service summary y accounts.service getStatementDirect
CREATE INDEX IF NOT EXISTS "Ticket_ventanaId_businessDate_deletedAt_idx"
  ON "Ticket" ("ventanaId", "businessDate", "deletedAt");

-- B1.5 AccountStatement: vendedorId + date
-- Beneficia: evaluatedSummary findFirst/findMany por vendedor+fecha, balance queries
CREATE INDEX IF NOT EXISTS "AccountStatement_vendedorId_date_idx"
  ON "AccountStatement" ("vendedorId", "date");


-- ============================================================================
-- ROLLBACK (ejecutar manualmente si se necesita revertir)
-- ============================================================================
-- DROP INDEX IF EXISTS "Sorteo_status_scheduledAt_idx";
-- DROP INDEX IF EXISTS "Jugada_ticketId_deletedAt_idx";
-- DROP INDEX IF EXISTS "Ticket_vendedorId_sorteoId_deletedAt_isActive_idx";
-- DROP INDEX IF EXISTS "Ticket_ventanaId_businessDate_deletedAt_idx";
-- DROP INDEX IF EXISTS "AccountStatement_vendedorId_date_idx";
