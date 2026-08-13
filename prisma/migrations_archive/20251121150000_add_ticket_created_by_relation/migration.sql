-- Migration: Add foreign key constraint for Ticket.createdBy
-- This migration adds the FK constraint for the createdBy field (already added in previous migration)

-- Add foreign key constraint for createdBy (optional, for data integrity)
-- Note: We use ON DELETE SET NULL because if a user is deleted, we want to preserve the audit trail
-- but set the createdBy to NULL rather than deleting the ticket
ALTER TABLE "Ticket" 
ADD CONSTRAINT "Ticket_createdBy_fkey" 
FOREIGN KEY ("createdBy") 
REFERENCES "User"("id") 
ON DELETE SET NULL;

