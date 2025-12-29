-- ============================================
-- ROLLBACK: Fase 2 - Triggers de Automatización
-- ============================================
-- Este script revierte la migración eliminando el trigger y la función.
-- SEGURO: No afecta datos existentes, solo elimina el trigger.
-- El código backend volverá a actualizar manualmente los statements.
-- ============================================

-- Eliminar trigger
DROP TRIGGER IF EXISTS account_payment_trigger ON "AccountPayment";

-- Eliminar función
DROP FUNCTION IF EXISTS update_account_statement_on_payment_change();


