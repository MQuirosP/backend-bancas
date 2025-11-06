-- Script de ROLLBACK para la migración de Account Statements
-- ⚠️ ADVERTENCIA: Este script eliminará TODAS las tablas AccountStatement y AccountPayment
-- ⚠️ Solo usar si necesitas revertir la migración completamente
-- ⚠️ Esto eliminará TODOS los datos de estados de cuenta y pagos

-- Desactivar temporalmente las verificaciones de foreign keys
SET session_replication_role = 'replica';

-- 1. Eliminar triggers primero
DROP TRIGGER IF EXISTS "AccountPayment_updatedAt" ON "AccountPayment";
DROP TRIGGER IF EXISTS "AccountStatement_updatedAt" ON "AccountStatement";

-- 2. Eliminar funciones de triggers
DROP FUNCTION IF EXISTS update_account_payment_updated_at();
DROP FUNCTION IF EXISTS update_account_statement_updated_at();

-- 3. Eliminar índices (se eliminan automáticamente con las tablas, pero por seguridad)
-- Los índices se eliminan automáticamente cuando se elimina la tabla

-- 4. Eliminar tablas (CASCADE elimina foreign keys automáticamente)
DROP TABLE IF EXISTS "AccountPayment" CASCADE;
DROP TABLE IF EXISTS "AccountStatement" CASCADE;

-- Reactivar verificaciones de foreign keys
SET session_replication_role = 'origin';

-- Verificación de limpieza
SELECT 
  CASE 
    WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'AccountStatement') 
    THEN 'ERROR: AccountStatement aún existe'
    ELSE 'OK: AccountStatement eliminado'
  END as account_statement_check;

SELECT 
  CASE 
    WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'AccountPayment') 
    THEN 'ERROR: AccountPayment aún existe'
    ELSE 'OK: AccountPayment eliminado'
  END as account_payment_check;

SELECT 'Rollback completado' as message;

