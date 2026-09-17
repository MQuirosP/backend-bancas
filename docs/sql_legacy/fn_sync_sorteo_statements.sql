-- ============================================================================
-- Función: fn_sync_sorteo_statements
-- Descripción:
--   Sincroniza de forma atómica y en lote los estados de cuenta (AccountStatement)
--   para todas las entidades (Vendedores, Ventanas y Bancas) afectadas por un sorteo
--   evaluado en una fecha de negocio específica (Costa Rica UTC-6).
--
-- Parámetros:
--   p_sorteo_id: UUID del sorteo recién evaluado.
--   p_dry_run:   BOOLEAN (opcional, default FALSE). Si es TRUE, calcula todo y
--                retorna el JSONB sin realizar ningún INSERT/UPDATE en AccountStatement.
--
-- Retorna:
--   JSONB con el desglose de resultados por entidad para auditoría y warmup de caché.
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_sync_sorteo_statements(
    p_sorteo_id UUID,
    p_dry_run BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_start_time TIMESTAMPTZ := clock_timestamp();
    v_sorteo_status VARCHAR;
    v_scheduled_at TIMESTAMP;
    v_business_date DATE;
    v_date_str VARCHAR(10);
    v_month_str VARCHAR(7);
    v_first_day_of_month DATE;
    v_is_first_day BOOLEAN;

    v_count_vendedores INT := 0;
    v_count_ventanas INT := 0;
    v_count_bancas INT := 0;

    v_statements JSONB := '[]'::JSONB;
    v_row_json JSONB;

    -- Variables temporales de iteración
    rec_vendedor RECORD;
    rec_ventana RECORD;
    rec_banca RECORD;

    v_total_sales NUMERIC(14,2);
    v_total_payouts NUMERIC(14,2);
    v_listero_commission NUMERIC(14,2);
    v_vendedor_commission NUMERIC(14,2);
    v_ticket_count INT;
    v_total_paid NUMERIC(14,2);
    v_total_collected NUMERIC(14,2);
    v_balance NUMERIC(14,2);
    v_prev_accumulated NUMERIC(14,2);
    v_accumulated_balance NUMERIC(14,2);
    v_is_settled BOOLEAN;

    v_balance_reset_at TIMESTAMPTZ;
    v_balance_reset_day DATE;
BEGIN
    -- 1. Validar sorteo y extraer fecha de negocio (Costa Rica UTC-6)
    SELECT "status", "scheduledAt"
    INTO v_sorteo_status, v_scheduled_at
    FROM "Sorteo"
    WHERE id = p_sorteo_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Sorteo con ID % no encontrado', p_sorteo_id USING ERRCODE = 'P0002';
    END IF;

    -- Fecha contable en Costa Rica (UTC-6)
    v_business_date := (v_scheduled_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')::DATE;
    v_date_str := to_char(v_business_date, 'YYYY-MM-DD');
    v_month_str := to_char(v_business_date, 'YYYY-MM');
    v_first_day_of_month := date_trunc('month', v_business_date)::DATE;
    v_is_first_day := (v_business_date = v_first_day_of_month);

    -- 2. Crear tablas temporales para almacenar las entidades a procesar
    CREATE TEMP TABLE tmp_affected_vendedores (
        vendedor_id UUID PRIMARY KEY,
        ventana_id UUID,
        banca_id UUID,
        balance_reset_at TIMESTAMPTZ,
        balance_reset_day DATE
    ) ON COMMIT DROP;

    CREATE TEMP TABLE tmp_affected_ventanas (
        ventana_id UUID PRIMARY KEY,
        banca_id UUID
    ) ON COMMIT DROP;

    CREATE TEMP TABLE tmp_affected_bancas (
        banca_id UUID PRIMARY KEY
    ) ON COMMIT DROP;

    -- 2.1 Identificar ventanas y bancas directamente afectadas por tickets del sorteo
    INSERT INTO tmp_affected_ventanas (ventana_id, banca_id)
    SELECT DISTINCT
        t."ventanaId",
        v."bancaId"
    FROM "Ticket" t
    JOIN "Ventana" v ON v.id = t."ventanaId"
    WHERE t."sorteoId" = p_sorteo_id
      AND t."deletedAt" IS NULL
      AND t."isActive" = TRUE
      AND t."status" != 'CANCELLED'
      AND t."ventanaId" IS NOT NULL
    ON CONFLICT (ventana_id) DO NOTHING;

    INSERT INTO tmp_affected_bancas (banca_id)
    SELECT DISTINCT banca_id
    FROM tmp_affected_ventanas
    WHERE banca_id IS NOT NULL
    ON CONFLICT (banca_id) DO NOTHING;

    -- 2.2 Expandir vendedores:
    -- Todos los vendedores con tickets en el sorteo O pertenecientes a las ventanas afectadas
    -- que tengan actividad hoy (tickets en la fecha, pagos en la fecha o statement previo en la fecha)
    INSERT INTO tmp_affected_vendedores (vendedor_id, ventana_id, banca_id, balance_reset_at, balance_reset_day)
    SELECT DISTINCT
        u.id AS vendedor_id,
        u."ventanaId" AS ventana_id,
        w."bancaId" AS banca_id,
        (u.settings->>'balanceResetAt')::TIMESTAMPTZ AS balance_reset_at,
        ((u.settings->>'balanceResetAt')::TIMESTAMPTZ AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')::DATE AS balance_reset_day
    FROM "User" u
    JOIN "Ventana" w ON w.id = u."ventanaId"
    WHERE u.role = 'VENDEDOR'
      AND u."deletedAt" IS NULL
      AND (
          -- Vendedores de las ventanas afectadas
          u."ventanaId" IN (SELECT ventana_id FROM tmp_affected_ventanas)
          OR
          -- O que tengan tickets en este sorteo específico
          u.id IN (
              SELECT DISTINCT t."vendedorId"
              FROM "Ticket" t
              WHERE t."sorteoId" = p_sorteo_id
                AND t."vendedorId" IS NOT NULL
                AND t."deletedAt" IS NULL
                AND t."isActive" = TRUE
                AND t."status" != 'CANCELLED'
          )
      )
      AND (
          -- Filtro de relevancia: solo si tienen actividad o statement hoy
          EXISTS (
              SELECT 1 FROM "Ticket" tk
              WHERE tk."vendedorId" = u.id
                AND tk."businessDate" = v_business_date
                AND tk."deletedAt" IS NULL
                AND tk."isActive" = TRUE
                AND tk."status" IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
          )
          OR EXISTS (
              SELECT 1 FROM "AccountPayment" ap
              WHERE ap."vendedorId" = u.id
                AND ap."date" = v_business_date
                AND ap."isReversed" = FALSE
          )
          OR EXISTS (
              SELECT 1 FROM "AccountStatement" ast
              WHERE ast."vendedorId" = u.id
                AND ast."date" = v_business_date
          )
      )
    ON CONFLICT (vendedor_id) DO NOTHING;

    -- ========================================================================
    -- 3. PROCESAR VENDEDORES (Orden Determinista ASC para prevenir deadlocks)
    -- ========================================================================
    FOR rec_vendedor IN
        SELECT vendedor_id, ventana_id, banca_id, balance_reset_at, balance_reset_day
        FROM tmp_affected_vendedores
        ORDER BY vendedor_id ASC
    LOOP
        v_balance_reset_at := rec_vendedor.balance_reset_at;
        v_balance_reset_day := rec_vendedor.balance_reset_day;

        -- 3.1 Ventas, Premios, Comisiones y Conteo de Tickets del día completo
        SELECT
            COALESCE(SUM(j.amount), 0),
            COALESCE(SUM(CASE WHEN j."isWinner" = TRUE THEN j.payout ELSE 0 END), 0),
            COALESCE(SUM(j."listeroCommissionAmount"), 0),
            COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0),
            COUNT(DISTINCT t.id)
        INTO
            v_total_sales,
            v_total_payouts,
            v_listero_commission,
            v_vendedor_commission,
            v_ticket_count
        FROM "Ticket" t
        JOIN "Sorteo" s ON s.id = t."sorteoId"
        JOIN "Jugada" j ON j."ticketId" = t.id
        WHERE t."vendedorId" = rec_vendedor.vendedor_id
          AND t."businessDate" = v_business_date
          AND t."deletedAt" IS NULL
          AND t."isActive" = TRUE
          AND t."status" IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
          AND s.status = 'EVALUATED'
          AND s."deletedAt" IS NULL
          AND j."deletedAt" IS NULL
          AND j."isActive" = TRUE
          AND j."isExcluded" = FALSE
          AND (
              v_balance_reset_at IS NULL
              OR v_business_date < v_balance_reset_day
              OR t."createdAt" >= v_balance_reset_at
          )
          AND NOT EXISTS (
              SELECT 1 FROM "sorteo_lista_exclusion" sle
              WHERE sle.sorteo_id = t."sorteoId"
                AND sle.ventana_id = t."ventanaId"
                AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
                AND sle.multiplier_id IS NULL
          );

        -- 3.2 Pagos y Cobros registrados en AccountPayment para la fecha
        SELECT
            COALESCE(SUM(CASE WHEN ap.type = 'payment' THEN ap.amount ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN ap.type = 'collection' THEN ap.amount ELSE 0 END), 0)
        INTO
            v_total_paid,
            v_total_collected
        FROM "AccountPayment" ap
        WHERE ap."vendedorId" = rec_vendedor.vendedor_id
          AND ap."date" = v_business_date
          AND ap."isReversed" = FALSE
          AND (ap.method IS NULL OR ap.method != 'SALDO_MES_ANTERIOR')
          AND (ap.notes IS NULL OR ap.notes NOT LIKE '%Saldo arrastrado del mes anterior%')
          AND (
              v_balance_reset_at IS NULL
              OR v_business_date < v_balance_reset_day
              OR ap."createdAt" >= v_balance_reset_at
          );

        -- Balance neto del día para el vendedor
        v_balance := ROUND(v_total_sales - v_total_payouts - v_vendedor_commission, 2);

        -- 3.3 Calcular Saldo Anterior Acumulado (previousDayAccumulated)
        v_prev_accumulated := 0;
        IF v_balance_reset_day IS NOT NULL AND v_business_date = v_balance_reset_day THEN
            v_prev_accumulated := 0;
        ELSIF v_is_first_day THEN
            -- Primer día del mes: buscar el último statement del mes anterior
            SELECT COALESCE("remainingBalance", "accumulatedBalance", 0)
            INTO v_prev_accumulated
            FROM "AccountStatement"
            WHERE "vendedorId" = rec_vendedor.vendedor_id
              AND "date" < v_first_day_of_month
            ORDER BY "date" DESC
            LIMIT 1;

            v_prev_accumulated := COALESCE(v_prev_accumulated, 0);
        ELSE
            -- Días posteriores: buscar el statement más reciente en el mismo mes
            SELECT COALESCE("remainingBalance", "accumulatedBalance", 0)
            INTO v_prev_accumulated
            FROM "AccountStatement"
            WHERE "vendedorId" = rec_vendedor.vendedor_id
              AND "date" < v_business_date
              AND "date" >= (
                  CASE
                      WHEN v_balance_reset_day IS NOT NULL AND v_balance_reset_day >= v_first_day_of_month
                      THEN v_balance_reset_day
                      ELSE v_first_day_of_month
                  END
              )
            ORDER BY "date" DESC
            LIMIT 1;

            IF v_prev_accumulated IS NULL THEN
                IF v_balance_reset_day IS NOT NULL AND v_business_date > v_balance_reset_day THEN
                    v_prev_accumulated := 0;
                ELSE
                    -- Fallback: último statement del mes anterior
                    SELECT COALESCE("remainingBalance", "accumulatedBalance", 0)
                    INTO v_prev_accumulated
                    FROM "AccountStatement"
                    WHERE "vendedorId" = rec_vendedor.vendedor_id
                      AND "date" < v_first_day_of_month
                    ORDER BY "date" DESC
                    LIMIT 1;

                    v_prev_accumulated := COALESCE(v_prev_accumulated, 0);
                END IF;
            END IF;
        END IF;

        -- 3.4 Acumulado y Estado de Saldado
        v_accumulated_balance := ROUND(v_prev_accumulated + v_balance + v_total_paid - v_total_collected, 2);
        v_is_settled := (v_ticket_count > 0 AND ABS(v_accumulated_balance) < 0.01 AND (v_total_paid > 0 OR v_total_collected > 0));

        -- 3.5 Persistencia Atómica (si no es Dry-Run)
        IF NOT p_dry_run THEN
            INSERT INTO "AccountStatement" (
                "id", "date", "month", "vendedorId", "ventanaId", "bancaId",
                "totalSales", "totalPayouts", "listeroCommission", "vendedorCommission",
                "balance", "totalPaid", "totalCollected", "accumulatedBalance", "remainingBalance",
                "isSettled", "canEdit", "ticketCount", "createdAt", "updatedAt"
            )
            VALUES (
                gen_random_uuid(), v_business_date, v_month_str, rec_vendedor.vendedor_id, NULL, rec_vendedor.banca_id,
                v_total_sales, v_total_payouts, v_listero_commission, v_vendedor_commission,
                v_balance, v_total_paid, v_total_collected, v_accumulated_balance, v_accumulated_balance,
                v_is_settled, TRUE, v_ticket_count, NOW(), NOW()
            )
            ON CONFLICT ("date", "vendedorId")
            DO UPDATE SET
                "bancaId" = EXCLUDED."bancaId",
                "totalSales" = EXCLUDED."totalSales",
                "totalPayouts" = EXCLUDED."totalPayouts",
                "listeroCommission" = EXCLUDED."listeroCommission",
                "vendedorCommission" = EXCLUDED."vendedorCommission",
                "balance" = EXCLUDED."balance",
                "totalPaid" = EXCLUDED."totalPaid",
                "totalCollected" = EXCLUDED."totalCollected",
                "accumulatedBalance" = EXCLUDED."accumulatedBalance",
                "remainingBalance" = EXCLUDED."remainingBalance",
                "isSettled" = EXCLUDED."isSettled",
                "ticketCount" = EXCLUDED."ticketCount",
                "updatedAt" = NOW();
        END IF;

        v_count_vendedores := v_count_vendedores + 1;

        -- Construir objeto JSON para el resultado
        v_row_json := jsonb_build_object(
            'dimension', 'vendedor',
            'entityId', rec_vendedor.vendedor_id,
            'ventanaId', rec_vendedor.ventana_id,
            'bancaId', rec_vendedor.banca_id,
            'totalSales', v_total_sales,
            'totalPayouts', v_total_payouts,
            'listeroCommission', v_listero_commission,
            'vendedorCommission', v_vendedor_commission,
            'balance', v_balance,
            'totalPaid', v_total_paid,
            'totalCollected', v_total_collected,
            'previousDayAccumulated', v_prev_accumulated,
            'accumulatedBalance', v_accumulated_balance,
            'remainingBalance', v_accumulated_balance,
            'ticketCount', v_ticket_count,
            'isSettled', v_is_settled
        );
        v_statements := v_statements || jsonb_build_array(v_row_json);
    END LOOP;

    -- ========================================================================
    -- 4. PROCESAR VENTANAS (Orden Determinista ASC)
    -- ========================================================================
    FOR rec_ventana IN
        SELECT ventana_id, banca_id
        FROM tmp_affected_ventanas
        ORDER BY ventana_id ASC
    LOOP
        -- 4.1 Ventas, Premios, Comisiones y Tickets a nivel de Ventana
        SELECT
            COALESCE(SUM(j.amount), 0),
            COALESCE(SUM(CASE WHEN j."isWinner" = TRUE THEN j.payout ELSE 0 END), 0),
            COALESCE(SUM(j."listeroCommissionAmount"), 0),
            COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0),
            COUNT(DISTINCT t.id)
        INTO
            v_total_sales,
            v_total_payouts,
            v_listero_commission,
            v_vendedor_commission,
            v_ticket_count
        FROM "Ticket" t
        JOIN "Sorteo" s ON s.id = t."sorteoId"
        JOIN "Jugada" j ON j."ticketId" = t.id
        WHERE t."ventanaId" = rec_ventana.ventana_id
          AND t."businessDate" = v_business_date
          AND t."deletedAt" IS NULL
          AND t."isActive" = TRUE
          AND t."status" IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
          AND s.status = 'EVALUATED'
          AND s."deletedAt" IS NULL
          AND j."deletedAt" IS NULL
          AND j."isActive" = TRUE
          AND j."isExcluded" = FALSE
          AND NOT EXISTS (
              SELECT 1 FROM "sorteo_lista_exclusion" sle
              WHERE sle.sorteo_id = t."sorteoId"
                AND sle.ventana_id = t."ventanaId"
                AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
                AND sle.multiplier_id IS NULL
          );

        -- 4.2 Pagos y Cobros propios de la Ventana (sin vendedor asociado)
        SELECT
            COALESCE(SUM(CASE WHEN ap.type = 'payment' THEN ap.amount ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN ap.type = 'collection' THEN ap.amount ELSE 0 END), 0)
        INTO
            v_total_paid,
            v_total_collected
        FROM "AccountPayment" ap
        WHERE ap."ventanaId" = rec_ventana.ventana_id
          AND ap."vendedorId" IS NULL
          AND ap."date" = v_business_date
          AND ap."isReversed" = FALSE
          AND (ap.method IS NULL OR ap.method != 'SALDO_MES_ANTERIOR')
          AND (ap.notes IS NULL OR ap.notes NOT LIKE '%Saldo arrastrado del mes anterior%');

        -- Balance neto del día para la ventana (deduce listeroCommission)
        v_balance := ROUND(v_total_sales - v_total_payouts - v_listero_commission, 2);

        -- 4.3 Saldo Anterior Acumulado de la Ventana
        v_prev_accumulated := 0;
        IF v_is_first_day THEN
            SELECT COALESCE("remainingBalance", "accumulatedBalance", 0)
            INTO v_prev_accumulated
            FROM "AccountStatement"
            WHERE "ventanaId" = rec_ventana.ventana_id
              AND "vendedorId" IS NULL
              AND "date" < v_first_day_of_month
            ORDER BY "date" DESC
            LIMIT 1;

            v_prev_accumulated := COALESCE(v_prev_accumulated, 0);
        ELSE
            SELECT COALESCE("remainingBalance", "accumulatedBalance", 0)
            INTO v_prev_accumulated
            FROM "AccountStatement"
            WHERE "ventanaId" = rec_ventana.ventana_id
              AND "vendedorId" IS NULL
              AND "date" < v_business_date
              AND "date" >= v_first_day_of_month
            ORDER BY "date" DESC
            LIMIT 1;

            IF v_prev_accumulated IS NULL THEN
                SELECT COALESCE("remainingBalance", "accumulatedBalance", 0)
                INTO v_prev_accumulated
                FROM "AccountStatement"
                WHERE "ventanaId" = rec_ventana.ventana_id
                  AND "vendedorId" IS NULL
                  AND "date" < v_first_day_of_month
                ORDER BY "date" DESC
                LIMIT 1;

                v_prev_accumulated := COALESCE(v_prev_accumulated, 0);
            END IF;
        END IF;

        v_accumulated_balance := ROUND(v_prev_accumulated + v_balance + v_total_paid - v_total_collected, 2);
        v_is_settled := (v_ticket_count > 0 AND ABS(v_accumulated_balance) < 0.01 AND (v_total_paid > 0 OR v_total_collected > 0));

        IF NOT p_dry_run THEN
            INSERT INTO "AccountStatement" (
                "id", "date", "month", "vendedorId", "ventanaId", "bancaId",
                "totalSales", "totalPayouts", "listeroCommission", "vendedorCommission",
                "balance", "totalPaid", "totalCollected", "accumulatedBalance", "remainingBalance",
                "isSettled", "canEdit", "ticketCount", "createdAt", "updatedAt"
            )
            VALUES (
                gen_random_uuid(), v_business_date, v_month_str, NULL, rec_ventana.ventana_id, rec_ventana.banca_id,
                v_total_sales, v_total_payouts, v_listero_commission, v_vendedor_commission,
                v_balance, v_total_paid, v_total_collected, v_accumulated_balance, v_accumulated_balance,
                v_is_settled, TRUE, v_ticket_count, NOW(), NOW()
            )
            ON CONFLICT ("date", "ventanaId") WHERE ("ventanaId" IS NOT NULL AND "vendedorId" IS NULL)
            DO UPDATE SET
                "bancaId" = EXCLUDED."bancaId",
                "totalSales" = EXCLUDED."totalSales",
                "totalPayouts" = EXCLUDED."totalPayouts",
                "listeroCommission" = EXCLUDED."listeroCommission",
                "vendedorCommission" = EXCLUDED."vendedorCommission",
                "balance" = EXCLUDED."balance",
                "totalPaid" = EXCLUDED."totalPaid",
                "totalCollected" = EXCLUDED."totalCollected",
                "accumulatedBalance" = EXCLUDED."accumulatedBalance",
                "remainingBalance" = EXCLUDED."remainingBalance",
                "isSettled" = EXCLUDED."isSettled",
                "ticketCount" = EXCLUDED."ticketCount",
                "updatedAt" = NOW();
        END IF;

        v_count_ventanas := v_count_ventanas + 1;

        v_row_json := jsonb_build_object(
            'dimension', 'ventana',
            'entityId', rec_ventana.ventana_id,
            'ventanaId', rec_ventana.ventana_id,
            'bancaId', rec_ventana.banca_id,
            'totalSales', v_total_sales,
            'totalPayouts', v_total_payouts,
            'listeroCommission', v_listero_commission,
            'vendedorCommission', v_vendedor_commission,
            'balance', v_balance,
            'totalPaid', v_total_paid,
            'totalCollected', v_total_collected,
            'previousDayAccumulated', v_prev_accumulated,
            'accumulatedBalance', v_accumulated_balance,
            'remainingBalance', v_accumulated_balance,
            'ticketCount', v_ticket_count,
            'isSettled', v_is_settled
        );
        v_statements := v_statements || jsonb_build_array(v_row_json);
    END LOOP;

    -- ========================================================================
    -- 5. PROCESAR BANCAS (Orden Determinista ASC)
    -- ========================================================================
    FOR rec_banca IN
        SELECT banca_id
        FROM tmp_affected_bancas
        ORDER BY banca_id ASC
    LOOP
        -- 5.1 Ventas, Premios, Comisiones y Tickets a nivel de Banca
        SELECT
            COALESCE(SUM(j.amount), 0),
            COALESCE(SUM(CASE WHEN j."isWinner" = TRUE THEN j.payout ELSE 0 END), 0),
            COALESCE(SUM(j."listeroCommissionAmount"), 0),
            COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0),
            COUNT(DISTINCT t.id)
        INTO
            v_total_sales,
            v_total_payouts,
            v_listero_commission,
            v_vendedor_commission,
            v_ticket_count
        FROM "Ticket" t
        JOIN "Ventana" v ON v.id = t."ventanaId"
        JOIN "Sorteo" s ON s.id = t."sorteoId"
        JOIN "Jugada" j ON j."ticketId" = t.id
        WHERE v."bancaId" = rec_banca.banca_id
          AND t."businessDate" = v_business_date
          AND t."deletedAt" IS NULL
          AND t."isActive" = TRUE
          AND t."status" IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
          AND s.status = 'EVALUATED'
          AND s."deletedAt" IS NULL
          AND j."deletedAt" IS NULL
          AND j."isActive" = TRUE
          AND j."isExcluded" = FALSE
          AND NOT EXISTS (
              SELECT 1 FROM "sorteo_lista_exclusion" sle
              WHERE sle.sorteo_id = t."sorteoId"
                AND sle.ventana_id = t."ventanaId"
                AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
                AND sle.multiplier_id IS NULL
          );

        -- 5.2 Pagos y Cobros propios de la Banca (sin ventana ni vendedor asociado)
        SELECT
            COALESCE(SUM(CASE WHEN ap.type = 'payment' THEN ap.amount ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN ap.type = 'collection' THEN ap.amount ELSE 0 END), 0)
        INTO
            v_total_paid,
            v_total_collected
        FROM "AccountPayment" ap
        WHERE ap."bancaId" = rec_banca.banca_id
          AND ap."ventanaId" IS NULL
          AND ap."vendedorId" IS NULL
          AND ap."date" = v_business_date
          AND ap."isReversed" = FALSE
          AND (ap.method IS NULL OR ap.method != 'SALDO_MES_ANTERIOR')
          AND (ap.notes IS NULL OR ap.notes NOT LIKE '%Saldo arrastrado del mes anterior%');

        -- Balance neto para la banca
        v_balance := ROUND(v_total_sales - v_total_payouts - v_listero_commission, 2);

        -- 5.3 Saldo Anterior Acumulado de la Banca
        v_prev_accumulated := 0;
        IF v_is_first_day THEN
            SELECT COALESCE("remainingBalance", "accumulatedBalance", 0)
            INTO v_prev_accumulated
            FROM "AccountStatement"
            WHERE "bancaId" = rec_banca.banca_id
              AND "ventanaId" IS NULL
              AND "vendedorId" IS NULL
              AND "date" < v_first_day_of_month
            ORDER BY "date" DESC
            LIMIT 1;

            v_prev_accumulated := COALESCE(v_prev_accumulated, 0);
        ELSE
            SELECT COALESCE("remainingBalance", "accumulatedBalance", 0)
            INTO v_prev_accumulated
            FROM "AccountStatement"
            WHERE "bancaId" = rec_banca.banca_id
              AND "ventanaId" IS NULL
              AND "vendedorId" IS NULL
              AND "date" < v_business_date
              AND "date" >= v_first_day_of_month
            ORDER BY "date" DESC
            LIMIT 1;

            IF v_prev_accumulated IS NULL THEN
                SELECT COALESCE("remainingBalance", "accumulatedBalance", 0)
                INTO v_prev_accumulated
                FROM "AccountStatement"
                WHERE "bancaId" = rec_banca.banca_id
                  AND "ventanaId" IS NULL
                  AND "vendedorId" IS NULL
                  AND "date" < v_first_day_of_month
                ORDER BY "date" DESC
                LIMIT 1;

                v_prev_accumulated := COALESCE(v_prev_accumulated, 0);
            END IF;
        END IF;

        v_accumulated_balance := ROUND(v_prev_accumulated + v_balance + v_total_paid - v_total_collected, 2);
        v_is_settled := (v_ticket_count > 0 AND ABS(v_accumulated_balance) < 0.01 AND (v_total_paid > 0 OR v_total_collected > 0));

        IF NOT p_dry_run THEN
            INSERT INTO "AccountStatement" (
                "id", "date", "month", "vendedorId", "ventanaId", "bancaId",
                "totalSales", "totalPayouts", "listeroCommission", "vendedorCommission",
                "balance", "totalPaid", "totalCollected", "accumulatedBalance", "remainingBalance",
                "isSettled", "canEdit", "ticketCount", "createdAt", "updatedAt"
            )
            VALUES (
                gen_random_uuid(), v_business_date, v_month_str, NULL, NULL, rec_banca.banca_id,
                v_total_sales, v_total_payouts, v_listero_commission, v_vendedor_commission,
                v_balance, v_total_paid, v_total_collected, v_accumulated_balance, v_accumulated_balance,
                v_is_settled, TRUE, v_ticket_count, NOW(), NOW()
            )
            ON CONFLICT ("date", "bancaId") WHERE ("ventanaId" IS NULL AND "vendedorId" IS NULL)
            DO UPDATE SET
                "totalSales" = EXCLUDED."totalSales",
                "totalPayouts" = EXCLUDED."totalPayouts",
                "listeroCommission" = EXCLUDED."listeroCommission",
                "vendedorCommission" = EXCLUDED."vendedorCommission",
                "balance" = EXCLUDED."balance",
                "totalPaid" = EXCLUDED."totalPaid",
                "totalCollected" = EXCLUDED."totalCollected",
                "accumulatedBalance" = EXCLUDED."accumulatedBalance",
                "remainingBalance" = EXCLUDED."remainingBalance",
                "isSettled" = EXCLUDED."isSettled",
                "ticketCount" = EXCLUDED."ticketCount",
                "updatedAt" = NOW();
        END IF;

        v_count_bancas := v_count_bancas + 1;

        v_row_json := jsonb_build_object(
            'dimension', 'banca',
            'entityId', rec_banca.banca_id,
            'bancaId', rec_banca.banca_id,
            'totalSales', v_total_sales,
            'totalPayouts', v_total_payouts,
            'listeroCommission', v_listero_commission,
            'vendedorCommission', v_vendedor_commission,
            'balance', v_balance,
            'totalPaid', v_total_paid,
            'totalCollected', v_total_collected,
            'previousDayAccumulated', v_prev_accumulated,
            'accumulatedBalance', v_accumulated_balance,
            'remainingBalance', v_accumulated_balance,
            'ticketCount', v_ticket_count,
            'isSettled', v_is_settled
        );
        v_statements := v_statements || jsonb_build_array(v_row_json);
    END LOOP;

    -- ========================================================================
    -- 6. Construir Resumen Final de Retorno
    -- ========================================================================
    RETURN jsonb_build_object(
        'success', TRUE,
        'sorteoId', p_sorteo_id,
        'businessDate', v_date_str,
        'dryRun', p_dry_run,
        'executionTimeMs', EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start_time)),
        'counts', jsonb_build_object(
            'vendedores', v_count_vendedores,
            'ventanas', v_count_ventanas,
            'bancas', v_count_bancas,
            'total', v_count_vendedores + v_count_ventanas + v_count_bancas
        ),
        'statements', v_statements
    );
END;
$$;
