-- Migration: Add audit fields to Ticket model (createdBy, createdByRole)
-- This migration is safe for production:
-- 1. Adds nullable fields (no breaking changes)
-- 2. Migrates existing data (sets createdBy = vendedorId, createdByRole = 'VENDEDOR')
-- 3. Adds index for performance

-- Step 1: Add nullable columns
ALTER TABLE "Ticket" 
ADD COLUMN IF NOT EXISTS "createdBy" UUID,
ADD COLUMN IF NOT EXISTS "createdByRole" "Role";

-- Step 2: Add foreign key constraint for createdBy (optional, but good for data integrity)
-- Note: We don't add FK constraint because createdBy might reference deleted users
-- Instead, we rely on application-level validation

-- Step 3: Migrate existing data
-- For existing tickets, assume they were created by the vendedor assigned to them
UPDATE "Ticket"
SET 
  "createdBy" = "vendedorId",
  "createdByRole" = 'VENDEDOR'
WHERE "createdBy" IS NULL;

-- Step 4: Add index for performance (queries filtering by createdBy)
CREATE INDEX IF NOT EXISTS "Ticket_createdBy_idx" ON "Ticket"("createdBy");

-- Step 5: Add comment for documentation
COMMENT ON COLUMN "Ticket"."createdBy" IS 'UserId del usuario que creó el ticket (para auditoría)';
COMMENT ON COLUMN "Ticket"."createdByRole" IS 'Rol del usuario que creó el ticket (ADMIN, VENTANA, o VENDEDOR)';

