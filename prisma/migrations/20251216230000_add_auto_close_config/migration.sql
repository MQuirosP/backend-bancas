-- ============================================================================
-- MIGRACIÓN: Agregar Campos de Auto-Close a SorteosAutoConfig
-- Fecha: 2025-12-16
-- Propósito: Habilitar configuración de cierre automático de sorteos sin ventas
-- Impacto: BAJO - Solo agrega columnas con valores default, no afecta datos existentes
-- ============================================================================

-- Agregar campos de auto-close a SorteosAutoConfig
ALTER TABLE "SorteosAutoConfig" ADD COLUMN IF NOT EXISTS "autoCloseEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SorteosAutoConfig" ADD COLUMN IF NOT EXISTS "closeCronSchedule" TEXT;
ALTER TABLE "SorteosAutoConfig" ADD COLUMN IF NOT EXISTS "lastCloseExecution" TIMESTAMP(3);
ALTER TABLE "SorteosAutoConfig" ADD COLUMN IF NOT EXISTS "lastCloseCount" INTEGER;

-- ============================================================================
-- VERIFICACIÓN POST-MIGRACIÓN
-- ============================================================================
-- Ejecutar para verificar que las columnas se crearon correctamente:
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'SorteosAutoConfig'
-- AND column_name IN ('autoCloseEnabled', 'closeCronSchedule', 'lastCloseExecution', 'lastCloseCount')
-- ORDER BY column_name;

-- ============================================================================
-- ROLLBACK (si es necesario)
-- ============================================================================
-- ALTER TABLE "SorteosAutoConfig" DROP COLUMN IF EXISTS "autoCloseEnabled";
-- ALTER TABLE "SorteosAutoConfig" DROP COLUMN IF EXISTS "closeCronSchedule";
-- ALTER TABLE "SorteosAutoConfig" DROP COLUMN IF EXISTS "lastCloseExecution";
-- ALTER TABLE "SorteosAutoConfig" DROP COLUMN IF EXISTS "lastCloseCount";
