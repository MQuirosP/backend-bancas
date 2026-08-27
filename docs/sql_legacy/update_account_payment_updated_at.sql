-- ============================================================
-- Función: update_account_payment_updated_at
-- Exportado: 2026-08-27T17:50:39.179Z
-- Fuente: pg_proc (schema: public)
-- ============================================================
BEGIN
  NEW."updatedAt" = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
