-- ============================================================
-- Función: fn_internal_sync_statements
-- Exportado: 2026-08-27T17:50:39.134Z
-- Fuente: pg_proc (schema: public)
-- ============================================================
DECLARE
      v_month VARCHAR;
  BEGIN
      v_month := to_char(p_business_date, 'YYYY-MM');

      -- Subquery reutilizable: todos los tickets de sorteos EVALUADOS del día p_business_date
      -- Se usa businessDate del ticket si existe, sino el rango de createdAt en hora CR (UTC-6)
      -- GROUP BY bancaId garantiza aislamiento por tenant sin contaminación cruzada

      -- Sincronización de VENDEDORES
      -- Agrega TODOS los sorteos evaluados del día para cada vendedor (no solo el sorteo actual)
      INSERT INTO "AccountStatement" (
          id, date, month, "vendedorId", "ventanaId", "bancaId",
          "totalSales", "totalPayouts", "listeroCommission", "vendedorCommission",
          balance, "totalPaid", "totalCollected", "remainingBalance", "accumulatedBalance",
          "isSettled", "canEdit", "ticketCount", "createdAt", "updatedAt"
      )
      SELECT
          gen_random_uuid(),
          p_business_date,
          v_month,
          t."vendedorId",
          NULL,
          v."bancaId",
          COALESCE(SUM(CASE WHEN t.status != 'CANCELLED' THEN t."totalAmount" ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN t.status != 'CANCELLED' THEN COALESCE(t."totalPayout", 0) ELSE 0 END), 0),
          0,
          COALESCE(SUM(
              CASE WHEN t.status != 'CANCELLED' THEN (
                  SELECT COALESCE(SUM(CASE WHEN (j2."type" = 'NUMERO' OR j2."type" = 'REVENTADO') AND j2."commissionOrigin" = 'USER' THEN j2."commissionAmount" ELSE 0 END), 0)
                  FROM "Jugada" j2
                  WHERE j2."ticketId" = t.id AND j2."deletedAt" IS NULL AND j2."isActive" = TRUE AND j2."isExcluded" = FALSE
              ) ELSE 0 END
          ), 0),
          COALESCE(SUM(CASE WHEN t.status != 'CANCELLED' THEN (
              t."totalAmount" - COALESCE(t."totalPayout", 0) - (
                  SELECT COALESCE(SUM(CASE WHEN (j2."type" = 'NUMERO' OR j2."type" = 'REVENTADO') AND j2."commissionOrigin" = 'USER' THEN j2."commissionAmount" ELSE 0 END), 0)
                  FROM "Jugada" j2
                  WHERE j2."ticketId" = t.id AND j2."deletedAt" IS NULL AND j2."isActive" = TRUE AND j2."isExcluded" = FALSE
              )
          ) ELSE 0 END), 0),
          0, 0, 0, 0,
          FALSE, TRUE,
          COUNT(DISTINCT t.id),
          NOW(), NOW()
      FROM "Ticket" t
      JOIN "Ventana" v ON t."ventanaId" = v.id
      JOIN "Sorteo" s ON t."sorteoId" = s.id
      WHERE (
          -- Usar businessDate si existe (campo estándar CR)
          t."businessDate" = p_business_date
          OR (
              t."businessDate" IS NULL AND
              t."createdAt" >= (p_business_date::TIMESTAMP + INTERVAL '6 hours') AND
              t."createdAt" <  (p_business_date::TIMESTAMP + INTERVAL '30 hours')
          )
      )
        AND s."status" = 'EVALUATED'
        AND s."deletedAt" IS NULL
        AND t."deletedAt" IS NULL
        AND t."vendedorId" IS NOT NULL
      GROUP BY t."vendedorId", v."bancaId"
      ON CONFLICT (date, "vendedorId") DO UPDATE SET
          "totalSales" = EXCLUDED."totalSales",
          "totalPayouts" = EXCLUDED."totalPayouts",
          "vendedorCommission" = EXCLUDED."vendedorCommission",
          balance = EXCLUDED.balance,
          "ticketCount" = EXCLUDED."ticketCount",
          "updatedAt" = NOW();

      -- Sincronización de VENTANAS
      -- Agrega TODOS los sorteos evaluados del día para cada ventana (aislamiento por tenant via GROUP BY)
      INSERT INTO "AccountStatement" (
          id, date, month, "vendedorId", "ventanaId", "bancaId",
          "totalSales", "totalPayouts", "listeroCommission", "vendedorCommission",
          balance, "totalPaid", "totalCollected", "remainingBalance", "accumulatedBalance",
          "isSettled", "canEdit", "ticketCount", "createdAt", "updatedAt"
      )
      SELECT
          gen_random_uuid(),
          p_business_date,
          v_month,
          NULL,
          t."ventanaId",
          v."bancaId",
          COALESCE(SUM(CASE WHEN t.status != 'CANCELLED' THEN t."totalAmount" ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN t.status != 'CANCELLED' THEN COALESCE(t."totalPayout", 0) ELSE 0 END), 0),
          COALESCE(SUM(
              CASE WHEN t.status != 'CANCELLED' THEN (
                  SELECT COALESCE(SUM(CASE WHEN (j2."type" = 'NUMERO' OR j2."type" = 'REVENTADO') THEN j2."listeroCommissionAmount" ELSE 0 END), 0)
                  FROM "Jugada" j2
                  WHERE j2."ticketId" = t.id AND j2."deletedAt" IS NULL AND j2."isActive" = TRUE AND j2."isExcluded" = FALSE
              ) ELSE 0 END
          ), 0),
          0,
          COALESCE(SUM(CASE WHEN t.status != 'CANCELLED' THEN (
              t."totalAmount" - COALESCE(t."totalPayout", 0) - (
                  SELECT COALESCE(SUM(CASE WHEN (j2."type" = 'NUMERO' OR j2."type" = 'REVENTADO') THEN j2."listeroCommissionAmount" ELSE 0 END), 0)
                  FROM "Jugada" j2
                  WHERE j2."ticketId" = t.id AND j2."deletedAt" IS NULL AND j2."isActive" = TRUE AND j2."isExcluded" = FALSE
              )
          ) ELSE 0 END), 0),
          0, 0, 0, 0,
          FALSE, TRUE,
          COUNT(DISTINCT t.id),
          NOW(), NOW()
      FROM "Ticket" t
      JOIN "Ventana" v ON t."ventanaId" = v.id
      JOIN "Sorteo" s ON t."sorteoId" = s.id
      WHERE (
          t."businessDate" = p_business_date
          OR (
              t."businessDate" IS NULL AND
              t."createdAt" >= (p_business_date::TIMESTAMP + INTERVAL '6 hours') AND
              t."createdAt" <  (p_business_date::TIMESTAMP + INTERVAL '30 hours')
          )
      )
        AND s."status" = 'EVALUATED'
        AND s."deletedAt" IS NULL
        AND t."deletedAt" IS NULL
      GROUP BY t."ventanaId", v."bancaId"
      ON CONFLICT (date, "ventanaId") WHERE "ventanaId" IS NOT NULL AND "vendedorId" IS NULL DO UPDATE SET
          "totalSales" = EXCLUDED."totalSales",
          "totalPayouts" = EXCLUDED."totalPayouts",
          "listeroCommission" = EXCLUDED."listeroCommission",
          balance = EXCLUDED.balance,
          "ticketCount" = EXCLUDED."ticketCount",
          "updatedAt" = NOW();

      -- Sincronización de BANCAS (Consolidado)
      -- Agrega TODOS los sorteos evaluados del día para cada banca (aislamiento por tenant via GROUP BY)
      INSERT INTO "AccountStatement" (
          id, date, month, "vendedorId", "ventanaId", "bancaId",
          "totalSales", "totalPayouts", "listeroCommission", "vendedorCommission",
          balance, "totalPaid", "totalCollected", "remainingBalance", "accumulatedBalance",
          "isSettled", "canEdit", "ticketCount", "createdAt", "updatedAt"
      )
      SELECT
          gen_random_uuid(),
          p_business_date,
          v_month,
          NULL,
          NULL,
          v."bancaId",
          COALESCE(SUM(CASE WHEN t.status != 'CANCELLED' THEN t."totalAmount" ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN t.status != 'CANCELLED' THEN COALESCE(t."totalPayout", 0) ELSE 0 END), 0),
          COALESCE(SUM(
              CASE WHEN t.status != 'CANCELLED' THEN (
                  SELECT COALESCE(SUM(CASE WHEN (j2."type" = 'NUMERO' OR j2."type" = 'REVENTADO') THEN j2."listeroCommissionAmount" ELSE 0 END), 0)
                  FROM "Jugada" j2
                  WHERE j2."ticketId" = t.id AND j2."deletedAt" IS NULL AND j2."isActive" = TRUE AND j2."isExcluded" = FALSE
              ) ELSE 0 END
          ), 0),
          0,
          COALESCE(SUM(CASE WHEN t.status != 'CANCELLED' THEN (
              t."totalAmount" - COALESCE(t."totalPayout", 0) - (
                  SELECT COALESCE(SUM(CASE WHEN (j2."type" = 'NUMERO' OR j2."type" = 'REVENTADO') THEN j2."listeroCommissionAmount" ELSE 0 END), 0)
                  FROM "Jugada" j2
                  WHERE j2."ticketId" = t.id AND j2."deletedAt" IS NULL AND j2."isActive" = TRUE AND j2."isExcluded" = FALSE
              )
          ) ELSE 0 END), 0),
          0, 0, 0, 0,
          FALSE, TRUE,
          COUNT(DISTINCT t.id),
          NOW(), NOW()
      FROM "Ticket" t
      JOIN "Ventana" v ON t."ventanaId" = v.id
      JOIN "Sorteo" s ON t."sorteoId" = s.id
      WHERE (
          t."businessDate" = p_business_date
          OR (
              t."businessDate" IS NULL AND
              t."createdAt" >= (p_business_date::TIMESTAMP + INTERVAL '6 hours') AND
              t."createdAt" <  (p_business_date::TIMESTAMP + INTERVAL '30 hours')
          )
      )
        AND s."status" = 'EVALUATED'
        AND s."deletedAt" IS NULL
        AND t."deletedAt" IS NULL
      GROUP BY v."bancaId"
      ON CONFLICT (date, "bancaId") WHERE "ventanaId" IS NULL AND "vendedorId" IS NULL DO UPDATE SET
          "totalSales" = EXCLUDED."totalSales",
          "totalPayouts" = EXCLUDED."totalPayouts",
          "listeroCommission" = EXCLUDED."listeroCommission",
          balance = EXCLUDED.balance,
          "ticketCount" = EXCLUDED."ticketCount",
          "updatedAt" = NOW();

      -- Recalcular accumulatedBalance / remainingBalance en base al día anterior y flujos de cobros/pagos

      -- 1. VENDEDORES
      UPDATE "AccountStatement" s
      SET "remainingBalance" = COALESCE((
              SELECT prev."remainingBalance"
              FROM "AccountStatement" prev
              LEFT JOIN "User" u ON u.id = s."vendedorId"
              WHERE prev."vendedorId" = s."vendedorId"
                AND prev.date < s.date
                AND (
                    u.settings IS NULL
                    OR u.settings->>'balanceResetAt' IS NULL
                    OR prev.date >= (u.settings->>'balanceResetAt')::date
                )
              ORDER BY prev.date DESC
              LIMIT 1
          ), 0) + s.balance + COALESCE(s."totalPaid", 0) - COALESCE(s."totalCollected", 0),
          "accumulatedBalance" = COALESCE((
              SELECT prev."remainingBalance"
              FROM "AccountStatement" prev
              LEFT JOIN "User" u ON u.id = s."vendedorId"
              WHERE prev."vendedorId" = s."vendedorId"
                AND prev.date < s.date
                AND (
                    u.settings IS NULL
                    OR u.settings->>'balanceResetAt' IS NULL
                    OR prev.date >= (u.settings->>'balanceResetAt')::date
                )
              ORDER BY prev.date DESC
              LIMIT 1
          ), 0) + s.balance + COALESCE(s."totalPaid", 0) - COALESCE(s."totalCollected", 0)
      WHERE s.date = p_business_date
        AND s."vendedorId" IS NOT NULL;

      -- 2. VENTANAS
      UPDATE "AccountStatement" s
      SET "remainingBalance" = COALESCE((
              SELECT prev."remainingBalance"
              FROM "AccountStatement" prev
              WHERE prev."ventanaId" = s."ventanaId"
                AND prev."vendedorId" IS NULL
                AND prev.date < s.date
              ORDER BY prev.date DESC
              LIMIT 1
          ), 0) + s.balance + COALESCE(s."totalPaid", 0) - COALESCE(s."totalCollected", 0),
          "accumulatedBalance" = COALESCE((
              SELECT prev."remainingBalance"
              FROM "AccountStatement" prev
              WHERE prev."ventanaId" = s."ventanaId"
                AND prev."vendedorId" IS NULL
                AND prev.date < s.date
              ORDER BY prev.date DESC
              LIMIT 1
          ), 0) + s.balance + COALESCE(s."totalPaid", 0) - COALESCE(s."totalCollected", 0)
      WHERE s.date = p_business_date
        AND s."ventanaId" IS NOT NULL
        AND s."vendedorId" IS NULL;

      -- 3. BANCAS
      UPDATE "AccountStatement" s
      SET "remainingBalance" = COALESCE((
              SELECT prev."remainingBalance"
              FROM "AccountStatement" prev
              WHERE prev."bancaId" = s."bancaId"
                AND prev."ventanaId" IS NULL
                AND prev."vendedorId" IS NULL
                AND prev.date < s.date
              ORDER BY prev.date DESC
              LIMIT 1
          ), 0) + s.balance + COALESCE(s."totalPaid", 0) - COALESCE(s."totalCollected", 0),
          "accumulatedBalance" = COALESCE((
              SELECT prev."remainingBalance"
              FROM "AccountStatement" prev
              WHERE prev."bancaId" = s."bancaId"
                AND prev."ventanaId" IS NULL
                AND prev."vendedorId" IS NULL
                AND prev.date < s.date
              ORDER BY prev.date DESC
              LIMIT 1
          ), 0) + s.balance + COALESCE(s."totalPaid", 0) - COALESCE(s."totalCollected", 0)
      WHERE s.date = p_business_date
        AND s."bancaId" IS NOT NULL
        AND s."ventanaId" IS NULL
        AND s."vendedorId" IS NULL;
  END;
