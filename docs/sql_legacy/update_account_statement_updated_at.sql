-- ============================================================
-- Función: update_account_statement_updated_at
-- Exportado: 2026-08-27T17:50:39.183Z
-- Fuente: pg_proc (schema: public)
-- ============================================================
BEGIN
  NEW."updatedAt" = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
