-- Migration: Cambiar onDelete de Cascade a Restrict en AccountPayment -> AccountStatement
-- ️ CRÍTICO: Este cambio previene que se borren AccountPayment cuando se borre un AccountStatement
-- Esto protege los datos críticos de producción (pagos/cobros)
--
-- IMPORTANTE: Esta migración debe aplicarse manualmente en producción con cuidado
-- Paso 1: Hacer backup de la base de datos
-- Paso 2: Ejecutar esta migración en ventana de mantenimiento
-- Paso 3: Verificar que no haya operaciones que dependan del comportamiento CASCADE

-- Paso 1: Eliminar la constraint existente
ALTER TABLE "AccountPayment"
  DROP CONSTRAINT IF EXISTS "AccountPayment_accountStatementId_fkey";

-- Paso 2: Crear la nueva constraint con RESTRICT
ALTER TABLE "AccountPayment"
  ADD CONSTRAINT "AccountPayment_accountStatementId_fkey"
  FOREIGN KEY ("accountStatementId")
  REFERENCES "AccountStatement"("id")
  ON DELETE RESTRICT;

-- Verificación: Confirmar que la constraint se creó correctamente
-- SELECT con_name, conrelid::regclass, confrelid::regclass, confdeltype
-- FROM pg_constraint
-- WHERE conname = 'AccountPayment_accountStatementId_fkey';
-- confdeltype debería ser 'r' (RESTRICT) en lugar de 'c' (CASCADE)
