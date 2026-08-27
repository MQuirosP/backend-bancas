-- ============================================================
-- Función: fn_close_sorteo
-- Exportado: 2026-08-27T17:50:39.131Z
-- Fuente: pg_proc (schema: public)
-- ============================================================
DECLARE
      v_sorteo_status VARCHAR;
      v_tickets_affected INT := 0;
      v_result JSONB;
  BEGIN
      -- 1. Bloqueo y lectura
      SELECT "status" INTO v_sorteo_status
      FROM "Sorteo"
      WHERE id = p_sorteo_id
      FOR UPDATE;

      IF NOT FOUND THEN
          RAISE EXCEPTION 'Sorteo no encontrado' USING ERRCODE = 'P0002';
      END IF;

      IF v_sorteo_status NOT IN ('OPEN', 'EVALUATED') THEN
          RAISE EXCEPTION 'Solo se pueden cerrar sorteos en estado OPEN o EVALUATED' USING ERRCODE = 'D0004';
      END IF;

      -- 2. Actualizar estado de Sorteo a CLOSED
      UPDATE "Sorteo"
      SET "status" = 'CLOSED'
      WHERE id = p_sorteo_id;

      -- 3. Actualizar bandera en cascada sobre los tickets activos
      WITH updated_tickets AS (
          UPDATE "Ticket"
          SET "isSorteoClosed" = TRUE
          WHERE "sorteoId" = p_sorteo_id
            AND "deletedAt" IS NULL
          RETURNING id
      )
      SELECT COUNT(*) INTO v_tickets_affected FROM updated_tickets;

      v_result := jsonb_build_object(
          'sorteoId', p_sorteo_id,
          'status', 'CLOSED',
          'ticketsAffected', v_tickets_affected
      );

      RETURN v_result;
  END;
