-- ============================================================
-- Función: fn_revert_sorteo
-- Exportado: 2026-08-27T17:50:39.135Z
-- Fuente: pg_proc (schema: public)
-- ============================================================
DECLARE
      v_sorteo_status VARCHAR;
      v_scheduled_at TIMESTAMP;
      v_business_date DATE;
      v_payments_deleted INT := 0;
      v_result JSONB;
  BEGIN
      -- 1. Bloqueo y validación de estado
      SELECT "status", "scheduledAt" INTO v_sorteo_status, v_scheduled_at
      FROM "Sorteo"
      WHERE id = p_sorteo_id
      FOR UPDATE;

      IF NOT FOUND THEN
          RAISE EXCEPTION 'Sorteo no encontrado' USING ERRCODE = 'P0002';
      END IF;

      IF v_sorteo_status != 'EVALUATED' THEN
          RAISE EXCEPTION 'Solo se puede revertir un sorteo evaluado' USING ERRCODE = 'D0003';
      END IF;

      v_business_date := (v_scheduled_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')::DATE;

      -- 2. Eliminar pagos de tickets asociados a este sorteo
      WITH deleted AS (
          DELETE FROM "TicketPayment" tp
          USING "Ticket" t
          WHERE tp."ticketId" = t.id
            AND t."sorteoId" = p_sorteo_id
          RETURNING tp.id
      )
      SELECT COUNT(*) INTO v_payments_deleted FROM deleted;

      -- 3. Resetear ganadores y montos de jugadas
      UPDATE "Jugada" j
      SET "isWinner" = FALSE,
          "payout" = 0,
          "finalMultiplierX" = CASE WHEN j."type" = 'REVENTADO' THEN 0 ELSE j."finalMultiplierX" END,
          "multiplierId" = CASE WHEN j."type" = 'REVENTADO' THEN NULL ELSE j."multiplierId" END
      FROM "Ticket" t
      WHERE j."ticketId" = t.id
        AND t."sorteoId" = p_sorteo_id
        AND j."deletedAt" IS NULL;

      -- 4. Restablecer estado de los tickets
      UPDATE "Ticket"
      SET "status" = 'ACTIVE',
          "isWinner" = FALSE,
          "totalPayout" = 0,
          "totalPaid" = 0,
          "remainingAmount" = 0,
          "lastPaymentAt" = NULL,
          "paidById" = NULL,
          "paymentMethod" = NULL,
          "paymentNotes" = NULL,
          "paymentHistory" = NULL
      WHERE "sorteoId" = p_sorteo_id
        AND "status" IN ('EVALUATED', 'PAID')
        AND "deletedAt" IS NULL;

      -- 5. Restablecer estado del sorteo
      UPDATE "Sorteo"
      SET "status" = 'OPEN',
          "winningNumber" = NULL,
          "extraOutcomeCode" = NULL,
          "extraMultiplierX" = NULL,
          "hasWinner" = FALSE,
          "extraMultiplierId" = NULL
      WHERE id = p_sorteo_id;

      -- 6. Recalcular contabilidad tras revertir
      PERFORM fn_internal_sync_statements(v_business_date, p_sorteo_id);

      v_result := jsonb_build_object(
          'sorteoId', p_sorteo_id,
          'status', 'OPEN',
          'paymentsDeleted', v_payments_deleted,
          'businessDate', v_business_date
      );

      RETURN v_result;
  END;
