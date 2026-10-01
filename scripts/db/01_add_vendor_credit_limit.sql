-- ============================================================================
-- MIGRATION: Vendor Credit Limit (Tope Individual de Caja por Vendedor)
-- Execution: Run manually in Supabase SQL Editor.
-- Note: Additive columns with defaults, fully backward compatible.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- BLOQUE 1: ENUM ActivityType
-- NOTA IMPORTANTE: En PostgreSQL, ALTER TYPE ... ADD VALUE no puede ejecutarse
-- dentro de un bloque de transacción (BEGIN ... COMMIT). Si tu cliente SQL
-- ejecuta scripts dentro de transacciones automáticas, ejecuta este bloque 1
-- por separado antes de continuar con los bloques siguientes.
-- ----------------------------------------------------------------------------
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'USER_CREDIT_LIMIT_UPDATE';

-- ----------------------------------------------------------------------------
-- BLOQUE 2: TABLE "User" - Agregar columnas de configuración y auditoría
-- (Columnas aditivas con defaults para cero downtime)
-- ----------------------------------------------------------------------------
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "creditLimit" double precision,
  ADD COLUMN IF NOT EXISTS "creditAlertThreshold" integer NOT NULL DEFAULT 80,
  ADD COLUMN IF NOT EXISTS "creditBlockMode" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "creditLimitUpdatedAt" timestamp(3),
  ADD COLUMN IF NOT EXISTS "creditLimitUpdatedById" uuid;

-- ----------------------------------------------------------------------------
-- BLOQUE 3: CHECK CONSTRAINTS (Idempotentes con nombres explícitos)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_credit_limit_positive'
  ) THEN
    ALTER TABLE "User"
      ADD CONSTRAINT chk_user_credit_limit_positive
      CHECK ("creditLimit" IS NULL OR "creditLimit" > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_credit_alert_threshold'
  ) THEN
    ALTER TABLE "User"
      ADD CONSTRAINT chk_user_credit_alert_threshold
      CHECK ("creditAlertThreshold" >= 1 AND "creditAlertThreshold" <= 100);
  END IF;
END $$;
