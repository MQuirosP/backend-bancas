-- ============================================================
-- Función: generate_ticket_number_v3
-- Exportado: 2026-08-27T17:50:39.142Z
-- Fuente: pg_proc (schema: public)
-- ============================================================
DECLARE
  v_date     DATE;
  v_date_str TEXT;
  v_seq_name TEXT;
  v_seq      BIGINT;
BEGIN
  v_date := COALESCE(
    p_business_date,
    (now() AT TIME ZONE 'America/Costa_Rica')::date
  );

  v_date_str := to_char(v_date, 'YYMMDD');
  v_seq_name := 'ticket_seq_' || v_date_str;

  IF NOT EXISTS (
    SELECT 1 FROM pg_sequences WHERE sequencename = v_seq_name
  ) THEN
    PERFORM pg_advisory_xact_lock(hashtext(v_seq_name));
    EXECUTE format(
      'CREATE SEQUENCE IF NOT EXISTS %I START 1 INCREMENT 1 NO MAXVALUE CACHE 1',
      v_seq_name
    );
  END IF;

  v_seq := nextval(v_seq_name);

  RETURN 'T' || v_date_str || '-' || lpad(v_seq::text, 5, '0');
END;
