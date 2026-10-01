-- ============================================================================
-- ROLLBACK: Vendor Credit Limit
-- Execution: Run manually in Supabase SQL Editor if rollback is needed.
-- Note: PostgreSQL does NOT support removing values from an ENUM type directly.
-- 'USER_CREDIT_LIMIT_UPDATE' remains in ActivityType without causing harm.
-- ============================================================================

-- 1. DROP CONSTRAINTS
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS chk_user_credit_limit_positive;
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS chk_user_credit_alert_threshold;

-- 2. DROP COLUMNS
ALTER TABLE "User"
  DROP COLUMN IF EXISTS "creditLimit",
  DROP COLUMN IF EXISTS "creditAlertThreshold",
  DROP COLUMN IF EXISTS "creditBlockMode",
  DROP COLUMN IF EXISTS "creditLimitUpdatedAt",
  DROP COLUMN IF EXISTS "creditLimitUpdatedById";
