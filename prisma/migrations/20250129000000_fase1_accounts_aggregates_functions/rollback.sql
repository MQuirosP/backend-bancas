-- ============================================
-- ROLLBACK: Fase 1 - Funciones de Agregación
-- ============================================
-- Este script revierte la migración eliminando las funciones creadas.
-- SEGURO: No afecta datos existentes, solo elimina funciones.
-- El código backend volverá a usar queries SQL directas.
-- ============================================

DROP FUNCTION IF EXISTS calculate_account_statement_aggregates(DATE, DATE, TEXT, UUID, UUID, UUID, BOOLEAN, BIGINT, TEXT);
DROP FUNCTION IF EXISTS get_account_payment_totals(UUID);


