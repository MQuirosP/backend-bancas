-- ====================================================================
-- MIGRACIÓN DE VISTAS MATERIALIZADAS CON AISLAMIENTO MULTI-TENANT (bancaId)
-- ====================================================================
-- Autor: Antigravity (Google Deepmind pair programmer)
-- Fecha: 17/05/2026
-- Objetivo: Agregar soporte nativo de "bancaId" en las vistas materializadas
--           mv_daily_account_summary y mv_diario_ventas_totales.
--           Esto elimina subconsultas pesadas e implementa índices cubrientes
--           para asegurar aislamientos seguros en consultas simultáneas.
-- ====================================================================

BEGIN;

-- --------------------------------------------------------------------
-- 1. ELIMINAR VISTAS Y LOGICA ANTIGUA
-- --------------------------------------------------------------------
-- RAISE NOTICE 'Eliminando vistas materializadas antiguas...';
DROP MATERIALIZED VIEW IF EXISTS mv_daily_account_summary CASCADE;
DROP MATERIALIZED VIEW IF EXISTS mv_diario_ventas_totales CASCADE;

-- --------------------------------------------------------------------
-- 2. CREACIÓN DE mv_daily_account_summary CON bancaId
-- --------------------------------------------------------------------
-- RAISE NOTICE 'Creando mv_daily_account_summary con columna bancaId...';
CREATE MATERIALIZED VIEW mv_daily_account_summary AS
SELECT 
  DATE(COALESCE(t."businessDate", t."createdAt")) as date,
  t."bancaId",
  t."ventanaId",
  t."vendedorId",
  COUNT(DISTINCT t.id) as ticket_count,
  COALESCE(SUM(t."totalAmount"), 0) as total_sales,
  COALESCE(SUM(CASE WHEN j."isWinner" THEN j.payout ELSE 0 END), 0) as total_payouts,
  COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) as vendedor_commission,
  COALESCE(SUM(j."listeroCommissionAmount"), 0) as listero_commission,
  COALESCE(SUM(t."totalAmount"), 0) - 
  COALESCE(SUM(CASE WHEN j."isWinner" THEN j.payout ELSE 0 END), 0) - 
  COALESCE(SUM(j."listeroCommissionAmount"), 0) - 
  COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) as balance
FROM "Ticket" t
LEFT JOIN "Jugada" j ON j."ticketId" = t.id AND j."deletedAt" IS NULL
WHERE t."deletedAt" IS NULL 
  AND t.status != 'CANCELLED'
  AND EXISTS (
    SELECT 1 FROM "Sorteo" s
    WHERE s.id = t."sorteoId"
    AND s.status = 'EVALUATED'
    AND s."deletedAt" IS NULL
  )
GROUP BY DATE(COALESCE(t."businessDate", t."createdAt")), t."bancaId", t."ventanaId", t."vendedorId";

-- Índices optimizados para refresco concurrente y búsquedas rápidas por tenant
CREATE UNIQUE INDEX idx_mv_daily_account_summary_unique ON mv_daily_account_summary(date, "bancaId", "ventanaId", "vendedorId");
CREATE INDEX idx_mv_daily_account_summary_banca ON mv_daily_account_summary("bancaId", date);

COMMENT ON MATERIALIZED VIEW mv_daily_account_summary IS 'Resúmenes diarios agregados por banca, ventana y vendedor. Soporta aislamiento estricto multi-tenant y refresco concurrente.';

-- --------------------------------------------------------------------
-- 3. CREACIÓN DE mv_diario_ventas_totales CON bancaId
-- --------------------------------------------------------------------
-- RAISE NOTICE 'Creando mv_diario_ventas_totales con columna bancaId...';
CREATE MATERIALIZED VIEW mv_diario_ventas_totales AS
WITH relevant_tickets AS (
  SELECT 
    t.id,
    t."bancaId",
    t."businessDate",
    t."vendedorId",
    t."ventanaId",
    t."loteriaId",
    t."sorteoId",
    t."createdAt"
  FROM "Ticket" t
  INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
  WHERE t."isActive" = true 
    AND t."deletedAt" IS NULL 
    AND t.status != 'CANCELLED' 
    AND s.status = 'EVALUATED'
), lm_active AS (
  SELECT 
    lm."loteriaId",
    lm."valueX",
    lm."appliesToDate",
    lm."appliesToSorteoId"
  FROM "LoteriaMultiplier" lm
  WHERE lm.kind = 'NUMERO' 
    AND lm."isActive" = true
), numero_bandas AS (
  SELECT 
    j."ticketId",
    j.number,
    MIN(j."finalMultiplierX") AS banda
  FROM "Jugada" j
  INNER JOIN relevant_tickets rt ON rt.id = j."ticketId"
  WHERE j.type = 'NUMERO' 
    AND j."isActive" = true 
    AND j."deletedAt" IS NULL
  GROUP BY j."ticketId", j.number
), calculated_jugadas AS (
  SELECT 
    rt."bancaId",
    rt."businessDate",
    rt."vendedorId",
    rt."ventanaId",
    rt."loteriaId",
    rt."sorteoId",
    j.type,
    CASE
      WHEN j.type = 'NUMERO' AND EXISTS (
        SELECT 1 FROM lm_active lm
        WHERE lm."loteriaId" = rt."loteriaId"
          AND lm."valueX" = j."finalMultiplierX"
          AND (lm."appliesToDate" IS NULL OR rt."createdAt" >= lm."appliesToDate")
          AND (lm."appliesToSorteoId" IS NULL OR lm."appliesToSorteoId" = rt."sorteoId")
      ) THEN j."finalMultiplierX"
      WHEN j.type = 'REVENTADO' THEN nb.banda
      ELSE NULL
    END AS banda,
    j.amount,
    j.payout,
    j."listeroCommissionAmount",
    j.id AS "jugadaId",
    rt.id AS "ticketId"
  FROM "Jugada" j
  INNER JOIN relevant_tickets rt ON j."ticketId" = rt.id
  LEFT JOIN numero_bandas nb ON nb."ticketId" = j."ticketId" AND nb.number = j.number AND j.type = 'REVENTADO'
  WHERE j."isActive" = true 
    AND j."deletedAt" IS NULL 
    AND j."isExcluded" = false
)
SELECT 
  "bancaId",
  "businessDate",
  "vendedorId",
  "ventanaId",
  "loteriaId",
  "sorteoId",
  type AS tipo,
  banda,
  SUM(amount) AS "totalVendida",
  SUM(COALESCE(payout, 0)) AS ganado,
  SUM(COALESCE("listeroCommissionAmount", 0)) AS "comisionTotal",
  COUNT(DISTINCT "ticketId")::integer AS "ticketsCount",
  COUNT("jugadaId")::integer AS "jugadasCount"
FROM calculated_jugadas
WHERE banda IS NOT NULL
GROUP BY "bancaId", "businessDate", "vendedorId", "ventanaId", "loteriaId", "sorteoId", type, banda;

-- Índices de cobertura únicos y por tenant
CREATE UNIQUE INDEX idx_mv_diario_ventas_unique ON mv_diario_ventas_totales("businessDate", "bancaId", "ventanaId", "vendedorId", "loteriaId", "sorteoId", tipo, banda);
CREATE INDEX idx_mv_diario_ventas_banca ON mv_diario_ventas_totales("bancaId", "businessDate");

COMMENT ON MATERIALIZED VIEW mv_diario_ventas_totales IS 'Agregación detallada diaria por banda, tipo, fecha, lotería y sorteo para cierres. Soporta aislamiento estricto multi-tenant y refresco concurrente.';

-- --------------------------------------------------------------------
-- 4. RECREACIÓN DE FUNCIONES DE REFRESCO
-- --------------------------------------------------------------------
-- RAISE NOTICE 'Actualizando funciones de refresco...';
CREATE OR REPLACE FUNCTION refresh_daily_account_summary()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_account_summary;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION refresh_diario_ventas_totales()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_diario_ventas_totales;
END;
$$ LANGUAGE plpgsql;

COMMIT;
