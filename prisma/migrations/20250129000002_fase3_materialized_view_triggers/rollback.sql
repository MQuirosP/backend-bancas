-- ============================================
-- ROLLBACK: Fase 3 - Triggers de Vista Materializada
-- ============================================
-- Este script revierte la migración eliminando triggers y funciones.
-- SEGURO: No afecta datos existentes, solo elimina triggers y funciones.
-- ============================================

-- Eliminar triggers
DROP TRIGGER IF EXISTS queue_refresh_on_ticket_change ON "Ticket";
DROP TRIGGER IF EXISTS queue_refresh_on_jugada_change ON "Jugada";

-- Eliminar funciones
DROP FUNCTION IF EXISTS queue_daily_summary_refresh();
DROP FUNCTION IF EXISTS queue_daily_summary_refresh_via_ticket();
DROP FUNCTION IF EXISTS refresh_daily_account_summary_smart();

-- Eliminar tabla de tracking (opcional, comentado por si quieres mantener historial)
-- DROP TABLE IF EXISTS mv_daily_account_summary_refresh_queue;


