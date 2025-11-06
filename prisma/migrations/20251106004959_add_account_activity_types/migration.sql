-- Add new ActivityType values for Account Statements system
-- These values were added to the Prisma schema but need to be added to the database enum
-- Note: ALTER TYPE ... ADD VALUE cannot be used in transactions in older PostgreSQL versions
-- If this migration fails, apply the values manually using scripts/add-activity-types-manually.sql

-- Add ACCOUNT_STATEMENT_VIEW
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum 
    WHERE enumlabel = 'ACCOUNT_STATEMENT_VIEW' 
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'ActivityType')
  ) THEN
    ALTER TYPE "ActivityType" ADD VALUE 'ACCOUNT_STATEMENT_VIEW';
  END IF;
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'ACCOUNT_STATEMENT_VIEW already exists';
END $$;

-- Add ACCOUNT_PAYMENT_CREATE
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum 
    WHERE enumlabel = 'ACCOUNT_PAYMENT_CREATE' 
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'ActivityType')
  ) THEN
    ALTER TYPE "ActivityType" ADD VALUE 'ACCOUNT_PAYMENT_CREATE';
  END IF;
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'ACCOUNT_PAYMENT_CREATE already exists';
END $$;

-- Add ACCOUNT_PAYMENT_REVERSE
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum 
    WHERE enumlabel = 'ACCOUNT_PAYMENT_REVERSE' 
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'ActivityType')
  ) THEN
    ALTER TYPE "ActivityType" ADD VALUE 'ACCOUNT_PAYMENT_REVERSE';
  END IF;
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'ACCOUNT_PAYMENT_REVERSE already exists';
END $$;

-- Add ACCOUNT_PAYMENT_HISTORY_VIEW
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum 
    WHERE enumlabel = 'ACCOUNT_PAYMENT_HISTORY_VIEW' 
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'ActivityType')
  ) THEN
    ALTER TYPE "ActivityType" ADD VALUE 'ACCOUNT_PAYMENT_HISTORY_VIEW';
  END IF;
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'ACCOUNT_PAYMENT_HISTORY_VIEW already exists';
END $$;

