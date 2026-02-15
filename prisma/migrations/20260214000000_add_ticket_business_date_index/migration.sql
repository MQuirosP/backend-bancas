-- ============================================================================
-- MIGRACION: Indice en Ticket.businessDate
-- SEGURIDAD: Solo crea indice - NO modifica datos ni estructura de tabla
-- NOTA: Usar CONCURRENTLY en produccion (ejecutar manualmente, no via migrate deploy)
-- ============================================================================

-- Indice principal: busquedas y filtros por businessDate
-- CONCURRENTLY evita bloquear la tabla durante la creacion
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Ticket_businessDate_idx"
  ON "Ticket" ("businessDate");
