-- ============================================================
-- Función: queue_daily_summary_refresh
-- Exportado: 2026-08-27T17:50:39.158Z
-- Fuente: pg_proc (schema: public)
-- ============================================================
DECLARE
    v_date DATE;
    v_ventana_id UUID;
    v_vendedor_id UUID;
BEGIN
    -- Determinar fecha y entidades según operación
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        v_date := COALESCE(NEW."businessDate", DATE(NEW."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'));
        v_ventana_id := NEW."ventanaId";
        v_vendedor_id := NEW."vendedorId";
    ELSE
        v_date := COALESCE(OLD."businessDate", DATE(OLD."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'));
        v_ventana_id := OLD."ventanaId";
        v_vendedor_id := OLD."vendedorId";
    END IF;

    -- Insertar en cola de refresco (ignorar si ya existe)
    INSERT INTO mv_daily_account_summary_refresh_queue (date, ventana_id, vendedor_id)
    VALUES (v_date, v_ventana_id, v_vendedor_id)
    ON CONFLICT (date, ventana_id, vendedor_id) DO NOTHING;

    RETURN COALESCE(NEW, OLD);
END;
