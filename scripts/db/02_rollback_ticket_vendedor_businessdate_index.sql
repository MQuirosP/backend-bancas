-- ============================================================================
-- ROLLBACK: Index for Vendor Credit Hydration
-- Target: Table "Ticket"
-- ============================================================================

DROP INDEX CONCURRENTLY IF EXISTS "idx_ticket_vendedor_businessdate";
