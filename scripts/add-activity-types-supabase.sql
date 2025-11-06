-- Script para agregar ActivityType values en Supabase
-- Copiar y pegar en SQL Editor de Supabase Dashboard

-- Add ACCOUNT_STATEMENT_VIEW
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum 
    WHERE enumlabel = 'ACCOUNT_STATEMENT_VIEW' 
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'ActivityType')
  ) THEN
    ALTER TYPE "ActivityType" ADD VALUE 'ACCOUNT_STATEMENT_VIEW';
    RAISE NOTICE 'ACCOUNT_STATEMENT_VIEW agregado';
  ELSE
    RAISE NOTICE 'ACCOUNT_STATEMENT_VIEW ya existe';
  END IF;
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'ACCOUNT_STATEMENT_VIEW ya existe (duplicate_object)';
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
    RAISE NOTICE 'ACCOUNT_PAYMENT_CREATE agregado';
  ELSE
    RAISE NOTICE 'ACCOUNT_PAYMENT_CREATE ya existe';
  END IF;
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'ACCOUNT_PAYMENT_CREATE ya existe (duplicate_object)';
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
    RAISE NOTICE 'ACCOUNT_PAYMENT_REVERSE agregado';
  ELSE
    RAISE NOTICE 'ACCOUNT_PAYMENT_REVERSE ya existe';
  END IF;
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'ACCOUNT_PAYMENT_REVERSE ya existe (duplicate_object)';
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
    RAISE NOTICE 'ACCOUNT_PAYMENT_HISTORY_VIEW agregado';
  ELSE
    RAISE NOTICE 'ACCOUNT_PAYMENT_HISTORY_VIEW ya existe';
  END IF;
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'ACCOUNT_PAYMENT_HISTORY_VIEW ya existe (duplicate_object)';
END $$;

