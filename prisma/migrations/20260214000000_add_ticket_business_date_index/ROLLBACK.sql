-- ============================================================================
-- ROLLBACK: Eliminar indice de Ticket.businessDate
-- ============================================================================

DROP INDEX CONCURRENTLY IF EXISTS "Ticket_businessDate_idx";
