-- ============================================================
-- Función: update_auto_date_restrictions
-- Exportado: 2026-08-27T17:50:39.196Z
-- Fuente: pg_proc (schema: public)
-- ============================================================
DECLARE
  day_of_month INTEGER;
  effective_number VARCHAR(2);
  affected_count INTEGER;
BEGIN
  day_of_month := EXTRACT(DAY FROM (CURRENT_TIMESTAMP AT TIME ZONE 'America/Costa_Rica')::DATE);
  effective_number := LPAD(day_of_month::TEXT, 2, '0');

  UPDATE "RestrictionRule"
  SET
    "number" = effective_number,
    "updatedAt" = NOW()
  WHERE
    "isAutoDate" = TRUE
    AND "isActive" = TRUE;

  GET DIAGNOSTICS affected_count = ROW_COUNT;

  INSERT INTO cron_execution_logs (
    job_name,
    status,
    executed_at,
    affected_rows,
    effective_number
  ) VALUES (
    'update_auto_restrictions',
    'success',
    NOW(),
    affected_count,
    effective_number
  );

  RAISE NOTICE 'Actualizadas % restricciones automáticas a número %', affected_count, effective_number;

EXCEPTION
  WHEN OTHERS THEN
    INSERT INTO cron_execution_logs (
      job_name,
      status,
      executed_at,
      error_message
    ) VALUES (
      'update_auto_restrictions',
      'error',
      NOW(),
      SQLERRM
    );
    RAISE EXCEPTION 'Error actualizando restricciones automáticas: %', SQLERRM;
END;
