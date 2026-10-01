-- ============================================================================
-- MIGRATION: Index for Vendor Credit Hydration
-- Target: Table "Ticket"
-- Execution: Run in PostgreSQL (CONCURRENTLY requires autocommit / outside tx).
-- Purpose: Optimize hydration query filtering by vendedorId and businessDate.
-- ============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_ticket_vendedor_businessdate"
  ON "Ticket" ("vendedorId", "businessDate")
  WHERE "deletedAt" IS NULL 
    AND "isActive" = true 
    AND status NOT IN ('CANCELLED'::"TicketStatus", 'EXCLUDED'::"TicketStatus");
