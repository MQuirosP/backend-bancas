-- ============================================================
-- Función: generate_ticket_number
-- Exportado: 2026-08-27T17:50:39.138Z
-- Fuente: pg_proc (schema: public)
-- ============================================================
DECLARE
  v_seq BIGINT := nextval('ticket_no_seq');
  v_b36 TEXT := to_base36(v_seq);
  v_cd  INT  := (v_seq % 97)::INT;
  v_dt  TEXT := to_char((now() AT TIME ZONE 'UTC'), 'YYMMDD');
BEGIN
  RETURN 'T' || v_dt || '-' ||
         lpad(v_b36, 6, '0') || '-' ||
         lpad(v_cd::TEXT, 2, '0');
END
