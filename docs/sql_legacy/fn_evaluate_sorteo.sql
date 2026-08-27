-- ============================================================
-- Función: fn_evaluate_sorteo
-- Exportado: 2026-08-27T17:50:39.132Z
-- Fuente: pg_proc (schema: public)
-- ============================================================
DECLARE
      v_sorteo_status VARCHAR;
      v_loteria_id UUID;
      v_scheduled_at TIMESTAMP;
      v_extra_x NUMERIC := 0;
      v_winners_count INT := 0;
      v_has_winner BOOLEAN := FALSE;
      v_business_date DATE;
      v_result JSONB;
  BEGIN
      -- 1. Bloqueo pesimista y lectura de estado del sorteo
      SELECT "status", "loteriaId", "scheduledAt"
      INTO v_sorteo_status, v_loteria_id, v_scheduled_at
      FROM "Sorteo"
      WHERE id = p_sorteo_id
      FOR UPDATE;

      IF NOT FOUND THEN
          RAISE EXCEPTION 'Sorteo no encontrado' USING ERRCODE = 'P0002';
      END IF;

      IF v_sorteo_status IN ('EVALUATED', 'CLOSED') THEN
          RAISE EXCEPTION 'Sorteo ya evaluado/cerrado' USING ERRCODE = 'D0001';
      END IF;

      -- Obtener la fecha de negocio del sorteo convertida a huso horario de Costa Rica (UTC-6)
      v_business_date := (v_scheduled_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')::DATE;

      -- 2. Resolver multiplicador extra si se provee
      IF p_extra_multiplier_id IS NOT NULL THEN
          SELECT "valueX" INTO v_extra_x
          FROM "LoteriaMultiplier"
          WHERE id = p_extra_multiplier_id AND "isActive" = TRUE AND "loteriaId" = v_loteria_id;

          IF NOT FOUND THEN
              RAISE EXCEPTION 'Multiplicador extra inválido o inactivo' USING ERRCODE = 'D0002';
          END IF;
      END IF;

      -- 3. Actualizar estado del sorteo
      UPDATE "Sorteo"
      SET "status" = 'EVALUATED',
          "winningNumber" = p_winning_number,
          "extraOutcomeCode" = p_extra_outcome_code,
          "extraMultiplierId" = p_extra_multiplier_id,
          "extraMultiplierX" = v_extra_x
      WHERE id = p_sorteo_id;

      -- 4. Evaluar jugadas de tipo NUMERO ganadoras
      UPDATE "Jugada" j
      SET "isWinner" = TRUE,
          "payout" = j."amount" * j."finalMultiplierX"
      FROM "Ticket" t
      WHERE j."ticketId" = t.id
        AND t."sorteoId" = p_sorteo_id
        AND t."status" != 'CANCELLED'
        AND t."isActive" = TRUE
        AND t."deletedAt" IS NULL
        AND j."type" = 'NUMERO'
        AND j."number" = p_winning_number
        AND j."isActive" = TRUE
        AND j."deletedAt" IS NULL;

      -- 5. Evaluar jugadas de tipo REVENTADO ganadoras
      IF v_extra_x > 0 THEN
          UPDATE "Jugada" j
          SET "isWinner" = TRUE,
              "finalMultiplierX" = v_extra_x,
              "payout" = j."amount" * v_extra_x,
              "multiplierId" = p_extra_multiplier_id
          FROM "Ticket" t
          WHERE j."ticketId" = t.id
            AND t."sorteoId" = p_sorteo_id
            AND t."status" != 'CANCELLED'
            AND t."isActive" = TRUE
            AND t."deletedAt" IS NULL
            AND j."type" = 'REVENTADO'
            AND j."reventadoNumber" = p_winning_number
            AND j."isActive" = TRUE
            AND j."deletedAt" IS NULL;
      END IF;

      -- 6. Marcar todos los tickets como EVALUATED e isWinner = false de base
      UPDATE "Ticket"
      SET "status" = 'EVALUATED',
          "isWinner" = FALSE,
          "totalPayout" = 0,
          "remainingAmount" = 0,
          "totalPaid" = 0
      WHERE "sorteoId" = p_sorteo_id
        AND "status" NOT IN ('CANCELLED', 'EXCLUDED')
        AND "deletedAt" IS NULL;

      -- 7. Actualizar tickets ganadores con sumatoria de payouts
      WITH Payouts AS (
          SELECT "ticketId", SUM("payout") AS total
          FROM "Jugada"
          WHERE "ticketId" IN (
              SELECT id FROM "Ticket"
              WHERE "sorteoId" = p_sorteo_id AND "deletedAt" IS NULL
          )
          AND "isWinner" = TRUE
          AND "deletedAt" IS NULL
          GROUP BY "ticketId"
      )
      UPDATE "Ticket" t
      SET "isWinner" = TRUE,
          "totalPayout" = p.total,
          "remainingAmount" = p.total
      FROM Payouts p
      WHERE t.id = p."ticketId"
        AND t."deletedAt" IS NULL;

      -- 8. Actualizar bandera hasWinner en el sorteo
      SELECT EXISTS (
          SELECT 1 FROM "Ticket"
          WHERE "sorteoId" = p_sorteo_id AND "isWinner" = TRUE AND "deletedAt" IS NULL
      ) INTO v_has_winner;

      UPDATE "Sorteo"
      SET "hasWinner" = v_has_winner
      WHERE id = p_sorteo_id;

      -- 9. Sincronización de AccountStatements la realiza Node.js (syncSorteoStatements)
      --    después de que este SP retorna. No se duplica aquí.

      -- Obtener contador de ganadores para auditoría
      SELECT COUNT(*) INTO v_winners_count
      FROM "Ticket"
      WHERE "sorteoId" = p_sorteo_id AND "isWinner" = TRUE AND "deletedAt" IS NULL;

      v_result := jsonb_build_object(
          'sorteoId', p_sorteo_id,
          'status', 'EVALUATED',
          'hasWinner', v_has_winner,
          'winnersCount', v_winners_count,
          'businessDate', v_business_date
      );

      RETURN v_result;
  END;
