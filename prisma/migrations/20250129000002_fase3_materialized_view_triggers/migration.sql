-- ============================================
-- FASE 3: Optimización de Vista Materializada
-- ============================================
-- Esta migración optimiza el refresco de mv_daily_account_summary
-- mediante un sistema de tracking de cambios y función de refresco mejorada.
--
-- NOTA: REFRESH MATERIALIZED VIEW CONCURRENTLY no puede ejecutarse en triggers
-- porque requiere estar fuera de una transacción. En su lugar, creamos un sistema
-- de tracking que permite refrescar de forma eficiente.
--
-- ROLLBACK SEGURO: Los triggers y funciones pueden eliminarse sin afectar datos.
--
-- Fecha: 2025-01-29
-- ============================================

-- ============================================
-- Tabla de Tracking: Cambios que requieren refresco
-- ============================================
-- Esta tabla trackea qué días necesitan refrescarse en la vista materializada
CREATE TABLE IF NOT EXISTS mv_daily_account_summary_refresh_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date DATE NOT NULL,
    ventana_id UUID,
    vendedor_id UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE,
    UNIQUE(date, ventana_id, vendedor_id)
);

CREATE INDEX IF NOT EXISTS idx_mv_refresh_queue_date ON mv_daily_account_summary_refresh_queue(date);
CREATE INDEX IF NOT EXISTS idx_mv_refresh_queue_processed ON mv_daily_account_summary_refresh_queue(processed_at) WHERE processed_at IS NULL;

-- ============================================
-- Función: Marcar días para refresco
-- ============================================
CREATE OR REPLACE FUNCTION queue_daily_summary_refresh()
RETURNS TRIGGER AS $$
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
$$ LANGUAGE plpgsql;

-- ============================================
-- Triggers: Marcar días afectados cuando cambian tickets
-- ============================================
DROP TRIGGER IF EXISTS queue_refresh_on_ticket_insert ON "Ticket";
CREATE TRIGGER queue_refresh_on_ticket_insert
    AFTER INSERT ON "Ticket"
    FOR EACH ROW
    EXECUTE FUNCTION queue_daily_summary_refresh();

DROP TRIGGER IF EXISTS queue_refresh_on_ticket_update ON "Ticket";
CREATE TRIGGER queue_refresh_on_ticket_update
    AFTER UPDATE ON "Ticket"
    FOR EACH ROW
    WHEN (
        OLD."businessDate" IS DISTINCT FROM NEW."businessDate" OR
        OLD."ventanaId" IS DISTINCT FROM NEW."ventanaId" OR
        OLD."vendedorId" IS DISTINCT FROM NEW."vendedorId" OR
        OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt" OR
        OLD.status IS DISTINCT FROM NEW.status
    )
    EXECUTE FUNCTION queue_daily_summary_refresh();

DROP TRIGGER IF EXISTS queue_refresh_on_ticket_delete ON "Ticket";
CREATE TRIGGER queue_refresh_on_ticket_delete
    AFTER DELETE ON "Ticket"
    FOR EACH ROW
    EXECUTE FUNCTION queue_daily_summary_refresh();

-- Función auxiliar para obtener ticket desde jugada
CREATE OR REPLACE FUNCTION queue_daily_summary_refresh_via_ticket()
RETURNS TRIGGER AS $$
DECLARE
    v_ticket_id UUID;
    v_date DATE;
    v_ventana_id UUID;
    v_vendedor_id UUID;
BEGIN
    -- Obtener ticket relacionado
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        v_ticket_id := NEW."ticketId";
    ELSE
        v_ticket_id := OLD."ticketId";
    END IF;
    
    -- Obtener datos del ticket
    SELECT 
        COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))),
        t."ventanaId",
        t."vendedorId"
    INTO v_date, v_ventana_id, v_vendedor_id
    FROM "Ticket" t
    WHERE t.id = v_ticket_id;
    
    IF v_date IS NOT NULL THEN
        -- Insertar en cola de refresco
        INSERT INTO mv_daily_account_summary_refresh_queue (date, ventana_id, vendedor_id)
        VALUES (v_date, v_ventana_id, v_vendedor_id)
        ON CONFLICT (date, ventana_id, vendedor_id) DO NOTHING;
    END IF;
    
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- También marcar cuando cambian jugadas (afectan payouts y comisiones)
DROP TRIGGER IF EXISTS queue_refresh_on_jugada_change ON "Jugada";
CREATE TRIGGER queue_refresh_on_jugada_change
    AFTER INSERT OR UPDATE OR DELETE ON "Jugada"
    FOR EACH ROW
    EXECUTE FUNCTION queue_daily_summary_refresh_via_ticket();

-- ============================================
-- Función Mejorada: Refrescar vista materializada
-- ============================================
-- Esta función puede ser llamada periódicamente (ej: cada hora) o manualmente
CREATE OR REPLACE FUNCTION refresh_daily_account_summary_smart()
RETURNS TABLE (
    refreshed_days INTEGER,
    queue_cleared BOOLEAN
) AS $$
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
$$ LANGUAGE plpgsql;

-- ============================================
-- Comentarios para documentación
-- ============================================
COMMENT ON TABLE mv_daily_account_summary_refresh_queue IS 
'Cola de días que requieren refresco en mv_daily_account_summary. Los triggers marcan automáticamente los días afectados.';

COMMENT ON FUNCTION queue_daily_summary_refresh() IS 
'Trigger function que marca días para refresco cuando cambian tickets.';

COMMENT ON FUNCTION refresh_daily_account_summary_smart() IS 
'Función mejorada para refrescar la vista materializada. Debe ejecutarse periódicamente (ej: cada hora) o manualmente.';

