--  CRÍTICO: Actualizar vista materializada para usar snapshot de comisión del listero
-- Esto es más preciso y rápido que calcular desde commissionOrigin

-- Primero, eliminar la vista materializada existente
DROP MATERIALIZED VIEW IF EXISTS mv_daily_account_summary CASCADE;

-- Recrear la vista materializada usando listeroCommissionAmount directamente
CREATE MATERIALIZED VIEW mv_daily_account_summary AS
SELECT 
  DATE(COALESCE(t."businessDate", t."createdAt")) as date,
  t."ventanaId",
  t."vendedorId",
  COUNT(DISTINCT t.id) as ticket_count,
  COALESCE(SUM(t."totalAmount"), 0) as total_sales,
  COALESCE(SUM(CASE WHEN j."isWinner" THEN j.payout ELSE 0 END), 0) as total_payouts,
  COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) as vendedor_commission,
  --  CRÍTICO: Usar snapshot de comisión del listero directamente
  COALESCE(SUM(j."listeroCommissionAmount"), 0) as listero_commission,
  -- Calcular balance: sales - payouts - listero_commission - vendedor_commission
  -- Nota: El balance se recalcula según el rol del usuario en el código
  COALESCE(SUM(t."totalAmount"), 0) - 
  COALESCE(SUM(CASE WHEN j."isWinner" THEN j.payout ELSE 0 END), 0) - 
  COALESCE(SUM(j."listeroCommissionAmount"), 0) - 
  COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) as balance
FROM "Ticket" t
LEFT JOIN "Jugada" j ON j."ticketId" = t.id AND j."deletedAt" IS NULL
WHERE t."deletedAt" IS NULL AND t.status != 'CANCELLED'
GROUP BY DATE(COALESCE(t."businessDate", t."createdAt")), t."ventanaId", t."vendedorId";

-- Recrear índices
CREATE INDEX IF NOT EXISTS idx_mv_daily_account_summary_date ON mv_daily_account_summary(date);
CREATE INDEX IF NOT EXISTS idx_mv_daily_account_summary_ventana ON mv_daily_account_summary("ventanaId", date) WHERE "ventanaId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mv_daily_account_summary_vendedor ON mv_daily_account_summary("vendedorId", date) WHERE "vendedorId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mv_daily_account_summary_ventana_vendedor ON mv_daily_account_summary("ventanaId", "vendedorId", date);

-- Recrear función de refresh
CREATE OR REPLACE FUNCTION refresh_daily_account_summary()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_account_summary;
END;
$$ LANGUAGE plpgsql;

-- Comentarios para documentación
COMMENT ON MATERIALIZED VIEW mv_daily_account_summary IS 'Vista materializada que pre-calcula resúmenes diarios de ventas, premios y comisiones por ventana/vendedor. Usa snapshot de listeroCommissionAmount para mayor precisión. Se debe refrescar periódicamente o después de cambios importantes en tickets/jugadas.';
COMMENT ON FUNCTION refresh_daily_account_summary() IS 'Función para refrescar la vista materializada mv_daily_account_summary. Usa CONCURRENTLY para evitar bloquear lecturas.';


