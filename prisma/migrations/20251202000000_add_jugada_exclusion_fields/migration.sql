-- ============================================================================
-- Migration: Add exclusion fields to Jugada (Production-safe)
-- Date: 2025-12-02
-- Description: Adds exclusion tracking at Jugada level, migrates existing data
-- ============================================================================

-- Step 1: Add exclusion fields to Jugada
ALTER TABLE "Jugada" ADD COLUMN IF NOT EXISTS "isExcluded" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Jugada" ADD COLUMN IF NOT EXISTS "excludedAt" TIMESTAMP;
ALTER TABLE "Jugada" ADD COLUMN IF NOT EXISTS "excludedBy" UUID;
ALTER TABLE "Jugada" ADD COLUMN IF NOT EXISTS "excludedReason" TEXT;

-- Step 2: Add foreign key to User (excludedBy)
ALTER TABLE "Jugada" ADD CONSTRAINT "Jugada_excludedBy_fkey"
  FOREIGN KEY ("excludedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Step 3: Create performance indexes
CREATE INDEX IF NOT EXISTS "Jugada_isActive_isExcluded_idx" ON "Jugada"("isActive", "isExcluded");
CREATE INDEX IF NOT EXISTS "Jugada_multiplierId_isExcluded_idx" ON "Jugada"("multiplierId", "isExcluded");

-- Step 4: Migrate existing exclusions from sorteo_lista_exclusion to Jugada
-- ️ IMPORTANTE: Esta migración marca jugadas como excluidas basándose en exclusiones existentes
-- La tabla sorteo_lista_exclusion NO se elimina por seguridad (se eliminará en migración futura)

DO $$
DECLARE
  exclusion_count INT;
  jugadas_updated INT := 0;
BEGIN
  -- Verificar si existe la tabla sorteo_lista_exclusion
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sorteo_lista_exclusion') THEN

    -- Contar exclusiones existentes
    SELECT COUNT(*) INTO exclusion_count FROM "sorteo_lista_exclusion";

    RAISE NOTICE 'Migrando % exclusiones existentes...', exclusion_count;

    -- Migrar exclusiones TOTALES (multiplier_id IS NULL)
    -- Esto marca TODAS las jugadas del vendedor/ventana
    UPDATE "Jugada"
    SET
      "isExcluded" = TRUE,
      "excludedAt" = ex."excluded_at",
      "excludedBy" = ex."excluded_by",
      "excludedReason" = ex."reason"
    FROM (
      SELECT DISTINCT
        j.id as jugada_id,
        sle."excluded_at",
        sle."excluded_by",
        sle."reason"
      FROM "Jugada" j
      JOIN "Ticket" t ON t.id = j."ticketId"
      JOIN "sorteo_lista_exclusion" sle ON sle."sorteo_id" = t."sorteoId"
      JOIN "User" u ON u.id = sle."ventana_id"
      WHERE t."ventanaId" = u."ventanaId"
        AND (sle."vendedor_id" IS NULL OR t."vendedorId" = sle."vendedor_id")
        AND sle."multiplier_id" IS NULL
        AND j."deletedAt" IS NULL
        AND j."isActive" = TRUE
    ) ex
    WHERE "Jugada".id = ex.jugada_id;

    GET DIAGNOSTICS jugadas_updated = ROW_COUNT;
    RAISE NOTICE 'Jugadas marcadas como excluidas (exclusión total): %', jugadas_updated;

    -- Migrar exclusiones PARCIALES (multiplier_id IS NOT NULL)
    -- Esto marca solo las jugadas con ese multiplicador específico
    UPDATE "Jugada"
    SET
      "isExcluded" = TRUE,
      "excludedAt" = ex."excluded_at",
      "excludedBy" = ex."excluded_by",
      "excludedReason" = ex."reason"
    FROM (
      SELECT DISTINCT
        j.id as jugada_id,
        sle."excluded_at",
        sle."excluded_by",
        sle."reason"
      FROM "Jugada" j
      JOIN "Ticket" t ON t.id = j."ticketId"
      JOIN "sorteo_lista_exclusion" sle ON sle."sorteo_id" = t."sorteoId"
      JOIN "User" u ON u.id = sle."ventana_id"
      WHERE t."ventanaId" = u."ventanaId"
        AND (sle."vendedor_id" IS NULL OR t."vendedorId" = sle."vendedor_id")
        AND sle."multiplier_id" IS NOT NULL
        AND j."multiplierId" = sle."multiplier_id"
        AND j."deletedAt" IS NULL
        AND j."isActive" = TRUE
    ) ex
    WHERE "Jugada".id = ex.jugada_id;

    GET DIAGNOSTICS jugadas_updated = ROW_COUNT;
    RAISE NOTICE 'Jugadas marcadas como excluidas (exclusión parcial): %', jugadas_updated;

  ELSE
    RAISE NOTICE 'Tabla sorteo_lista_exclusion no existe, saltando migración de datos';
  END IF;
END $$;

-- Step 5: Verificación post-migración
DO $$
DECLARE
  excluded_count INT;
BEGIN
  SELECT COUNT(*) INTO excluded_count FROM "Jugada" WHERE "isExcluded" = TRUE;
  RAISE NOTICE 'Total de jugadas excluidas después de migración: %', excluded_count;
END $$;

-- ============================================================================
-- NOTA: La tabla sorteo_lista_exclusion NO se elimina en esta migración
-- por seguridad en producción. Se eliminará en una migración posterior
-- después de verificar que todo funciona correctamente.
-- ============================================================================
