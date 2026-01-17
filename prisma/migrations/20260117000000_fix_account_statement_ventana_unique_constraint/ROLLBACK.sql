-- ============================================================================
-- ROLLBACK: Revertir corrección de constraint único parcial de ventanaId
-- ============================================================================
--
-- Este script revierte al comportamiento anterior:
-- (date, ventanaId) WHERE ventanaId IS NOT NULL
--
-- ADVERTENCIA: Ejecutar solo si la migración causa problemas.
-- Después de revertir, el carry-forward de vendedores con ventana fallará
-- con errores de constraint único.
--
-- ============================================================================

-- PASO 1: Eliminar el constraint nuevo
DROP INDEX IF EXISTS "account_statements_date_ventana_unique";

-- PASO 2: Recrear el constraint original (sin la condición de vendedorId)
CREATE UNIQUE INDEX "account_statements_date_ventana_unique"
ON "AccountStatement"("date", "ventanaId")
WHERE "ventanaId" IS NOT NULL;

-- ============================================================================
-- DESPUÉS DEL ROLLBACK:
-- Si necesitas eliminar statements duplicados que se hayan creado:
--
-- DELETE FROM "AccountStatement" a
-- USING "AccountStatement" b
-- WHERE a.date = b.date
--   AND a."ventanaId" = b."ventanaId"
--   AND a."vendedorId" IS NOT NULL  -- Eliminar los de vendedor
--   AND b."vendedorId" IS NULL      -- Mantener los consolidados
--   AND a.id <> b.id;
--
-- ============================================================================
