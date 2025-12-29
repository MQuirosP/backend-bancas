-- ============================================
-- ROLLBACK: Fase 4 - Validaciones
-- ============================================
-- Este script revierte la migración eliminando triggers y funciones.
-- SEGURO: No afecta datos existentes, solo elimina validaciones.
-- El código backend puede volver a validar manualmente.
-- ============================================

-- Eliminar triggers
DROP TRIGGER IF EXISTS validate_account_payment_trigger ON "AccountPayment";
DROP TRIGGER IF EXISTS validate_payment_reversal_trigger ON "AccountPayment";

-- Eliminar funciones
DROP FUNCTION IF EXISTS validate_account_payment();
DROP FUNCTION IF EXISTS validate_payment_reversal();


