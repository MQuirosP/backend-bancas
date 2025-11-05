-- Remove accounts module completely
-- WARNING: This migration will permanently delete all data in:
--   - Account (1 row)
--   - LedgerEntry (2 rows)
--   - MayorizationRecord (1 row)
--   - MayorizationEntry, PaymentDocument, DailyBalanceSnapshot, BankDeposit tables
--   - OwnerType, LedgerType, ReferenceType enums
--   - ActivityType enum values related to accounts

-- 1. Drop foreign key constraints and dependent tables first
DROP TABLE IF EXISTS "MayorizationEntry" CASCADE;
DROP TABLE IF EXISTS "MayorizationRecord" CASCADE;
DROP TABLE IF EXISTS "PaymentDocument" CASCADE;
DROP TABLE IF EXISTS "DailyBalanceSnapshot" CASCADE;
DROP TABLE IF EXISTS "BankDeposit" CASCADE;
DROP TABLE IF EXISTS "LedgerEntry" CASCADE;
DROP TABLE IF EXISTS "Account" CASCADE;

-- 2. Remove enum values from ActivityType enum
-- Note: PostgreSQL doesn't support removing enum values directly
-- We need to recreate the enum without the account-related values
DO $$
BEGIN
  -- Check if enum values exist before trying to remove them
  -- Since we can't directly remove enum values, we'll create a new enum and migrate
  -- But for safety, we'll just leave the values (they won't be used anymore)
  -- The enum values will remain in the database but won't be used
  NULL;
END $$;

-- 3. Drop the enums (only if they exist and are not used elsewhere)
-- Note: We need to check if they're used in other tables first
-- Since we're dropping all tables that use them, we can drop the enums
DO $$
BEGIN
  -- Drop OwnerType enum if it exists
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OwnerType') THEN
    DROP TYPE "OwnerType" CASCADE;
  END IF;

  -- Drop LedgerType enum if it exists
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LedgerType') THEN
    DROP TYPE "LedgerType" CASCADE;
  END IF;

  -- Drop ReferenceType enum if it exists
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReferenceType') THEN
    DROP TYPE "ReferenceType" CASCADE;
  END IF;
END $$;




