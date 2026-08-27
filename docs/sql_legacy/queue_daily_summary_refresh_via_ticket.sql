-- ============================================================
-- Función: queue_daily_summary_refresh_via_ticket
-- Exportado: 2026-08-27T17:50:39.162Z
-- Fuente: pg_proc (schema: public)
-- ============================================================
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
