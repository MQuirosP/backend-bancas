-- ============================================================================
-- MIGRACIÓN: Corregir constraint único parcial de ventanaId en AccountStatement
-- ============================================================================
--
-- PROBLEMA:
-- El constraint actual es: (date, ventanaId) WHERE ventanaId IS NOT NULL
-- Esto aplica a TODOS los registros con ventanaId, incluyendo:
--   - Statements consolidados de ventana (vendedorId = NULL)
--   - Statements de vendedores que pertenecen a una ventana (vendedorId = X)
--
-- Esto causa conflictos cuando un vendedor tiene ventanaId asignado y ya existe
-- un statement consolidado de ventana para el mismo día.
--
-- SOLUCIÓN:
-- Cambiar el constraint para que solo aplique a statements consolidados:
-- (date, ventanaId) WHERE ventanaId IS NOT NULL AND vendedorId IS NULL
--
-- Esto permite:
--   - Un solo statement consolidado por ventana por día
--   - Múltiples statements de vendedores para la misma ventana en el mismo día
--
-- ============================================================================

-- PASO 1: Eliminar el constraint existente
-- Nota: Si está asociado a un constraint, hay que eliminar el constraint primero
ALTER TABLE "AccountStatement" DROP CONSTRAINT IF EXISTS "account_statements_date_ventana_unique";
DROP INDEX IF EXISTS "account_statements_date_ventana_unique";

-- PASO 2: Crear el nuevo constraint con la condición correcta
-- Solo aplica a statements consolidados de ventana (vendedorId IS NULL)
CREATE UNIQUE INDEX "account_statements_date_ventana_unique"
ON "AccountStatement"("date", "ventanaId")
WHERE "ventanaId" IS NOT NULL AND "vendedorId" IS NULL;

-- ============================================================================
-- VERIFICACIÓN POST-MIGRACIÓN:
-- Ejecutar para confirmar que el constraint está correcto:
--
-- SELECT indexname, indexdef
-- FROM pg_indexes
-- WHERE tablename = 'AccountStatement'
-- AND indexname = 'account_statements_date_ventana_unique';
--
-- Resultado esperado debe incluir: WHERE ((ventanaId IS NOT NULL) AND (vendedorId IS NULL))
-- ============================================================================
