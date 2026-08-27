-- ============================================================
-- Función: get_account_payment_totals
-- Exportado: 2026-08-27T17:50:39.153Z
-- Fuente: pg_proc (schema: public)
-- ============================================================
BEGIN
    RETURN QUERY
    SELECT
        COALESCE(SUM(CASE WHEN ap.type = 'payment' AND NOT ap."isReversed" THEN ap.amount ELSE 0 END), 0)::NUMERIC as total_paid,
        COALESCE(SUM(CASE WHEN ap.type = 'collection' AND NOT ap."isReversed" THEN ap.amount ELSE 0 END), 0)::NUMERIC as total_collected,
        COALESCE(SUM(CASE WHEN NOT ap."isReversed" THEN ap.amount ELSE 0 END), 0)::NUMERIC as total_payments_collections
    FROM "AccountPayment" ap
    WHERE ap."accountStatementId" = p_account_statement_id;
END;
