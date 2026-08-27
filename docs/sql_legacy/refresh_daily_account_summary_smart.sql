-- ============================================================
-- Función: refresh_daily_account_summary_smart
-- Exportado: 2026-08-27T17:50:39.163Z
-- Fuente: pg_proc (schema: public)
-- ============================================================
DECLARE
    v_refreshed_days INTEGER := 0;
BEGIN
    -- Refrescar la vista materializada completamente
    -- NOTA: CONCURRENTLY requiere que no haya cambios pendientes, pero es más seguro
    -- En producción, considerar refrescar solo días específicos si hay muchos datos
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_account_summary;

    -- Marcar todos los items de la cola como procesados
    UPDATE mv_daily_account_summary_refresh_queue
    SET processed_at = NOW()
    WHERE processed_at IS NULL;

    -- Contar días refrescados
    SELECT COUNT(DISTINCT date) INTO v_refreshed_days
    FROM mv_daily_account_summary_refresh_queue
    WHERE processed_at IS NOT NULL
    AND processed_at >= NOW() - INTERVAL '1 hour';

    -- Limpiar items procesados hace más de 7 días
    DELETE FROM mv_daily_account_summary_refresh_queue
    WHERE processed_at IS NOT NULL
    AND processed_at < NOW() - INTERVAL '7 days';

    RETURN QUERY SELECT v_refreshed_days, true;
END;
