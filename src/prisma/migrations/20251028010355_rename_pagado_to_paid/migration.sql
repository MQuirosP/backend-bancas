-- PostgreSQL enum migration: rename PAGADO to PAID
-- NOTE: This migration completes the schema.prisma changes
-- The TicketStatus enum had PAGADO added in migration 20251027144605
-- This migration documents that we're keeping PAID as the canonical name
-- and any existing PAGADO values will need manual migration

-- Placeholder for documentation
-- The schema.prisma enum has been updated to use PAID instead of PAGADO
-- Application code has been updated to use TicketStatus.PAID
