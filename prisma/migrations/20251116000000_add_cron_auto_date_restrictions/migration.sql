-- Add isAutoDate field to RestrictionRule
ALTER TABLE "RestrictionRule" ADD COLUMN IF NOT EXISTS "isAutoDate" BOOLEAN NOT NULL DEFAULT false;

-- Create index for performance
CREATE INDEX IF NOT EXISTS "idx_restriction_rule_auto_date_active" 
  ON "RestrictionRule"("isAutoDate", "isActive") 
  WHERE "isAutoDate" = TRUE AND "isActive" = TRUE;

-- Enable pg_cron extension (if available)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Create table for cron execution logs
CREATE TABLE IF NOT EXISTS cron_execution_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('success', 'error')),
  executed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  affected_rows INTEGER,
  effective_number VARCHAR(2), -- Día del mes actualizado (01-31)
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cron_logs_job_name 
  ON cron_execution_logs(job_name, executed_at DESC);

CREATE INDEX IF NOT EXISTS idx_cron_logs_status 
  ON cron_execution_logs(status, executed_at DESC);

-- Function: Update auto date restrictions
CREATE OR REPLACE FUNCTION update_auto_date_restrictions()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  day_of_month INTEGER;
  effective_number VARCHAR(2);
  affected_count INTEGER;
BEGIN
  -- Obtener día del mes actual en CR timezone
  day_of_month := EXTRACT(DAY FROM (CURRENT_TIMESTAMP AT TIME ZONE 'America/Costa_Rica')::DATE);
  effective_number := LPAD(day_of_month::TEXT, 2, '0'); -- Asegurar formato 01-31
  
  -- Actualizar todas las restricciones automáticas activas
  UPDATE "RestrictionRule"
  SET 
    "number" = effective_number,
    "updatedAt" = NOW()
  WHERE 
    "isAutoDate" = TRUE 
    AND "isActive" = TRUE;
  
  -- Obtener número de filas afectadas
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  
  -- Registrar ejecución exitosa
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
  
  -- Log para debugging
  RAISE NOTICE 'Actualizadas % restricciones automáticas a número %', affected_count, effective_number;
  
EXCEPTION
  WHEN OTHERS THEN
    -- Registrar error
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
    
    -- Re-lanzar excepción para que pg_cron la registre
    RAISE EXCEPTION 'Error actualizando restricciones automáticas: %', SQLERRM;
END;
$$;

-- Function: Verify and rescue auto restrictions
CREATE OR REPLACE FUNCTION verify_auto_restrictions()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  day_of_month INTEGER;
  expected_number VARCHAR(2);
  last_run_date DATE;
  current_number VARCHAR(2);
  hours_since_last_run NUMERIC;
BEGIN
  -- Obtener día actual
  day_of_month := EXTRACT(DAY FROM (CURRENT_TIMESTAMP AT TIME ZONE 'America/Costa_Rica')::DATE);
  expected_number := LPAD(day_of_month::TEXT, 2, '0');
  
  -- Verificar última ejecución exitosa
  SELECT DATE(executed_at) INTO last_run_date
  FROM cron_execution_logs
  WHERE job_name = 'update_auto_restrictions'
    AND status = 'success'
  ORDER BY executed_at DESC
  LIMIT 1;
  
  -- Calcular horas desde última ejecución
  IF last_run_date IS NOT NULL THEN
    hours_since_last_run := EXTRACT(EPOCH FROM (NOW() - last_run_date)) / 3600;
  ELSE
    hours_since_last_run := 999; -- Nunca ejecutado
  END IF;
  
  -- Si la última ejecución fue hace más de 25 horas, ejecutar actualización de rescate
  IF last_run_date IS NULL OR hours_since_last_run > 25 THEN
    RAISE NOTICE 'Ejecutando actualización de rescate. Última ejecución: %, horas desde entonces: %', 
      last_run_date, hours_since_last_run;
    PERFORM update_auto_date_restrictions();
    RETURN;
  END IF;
  
  -- Verificar que el número actual sea correcto
  SELECT "number" INTO current_number
  FROM "RestrictionRule"
  WHERE "isAutoDate" = TRUE
    AND "isActive" = TRUE
  LIMIT 1;
  
  -- Si hay restricciones automáticas y el número es incorrecto, corregir
  IF current_number IS NOT NULL AND current_number != expected_number THEN
    RAISE NOTICE 'Número incorrecto detectado: %, esperado: %, ejecutando corrección', 
      current_number, expected_number;
    PERFORM update_auto_date_restrictions();
  END IF;
END;
$$;

-- Function: Check cron health (for frontend monitoring)
CREATE OR REPLACE FUNCTION check_cron_health()
RETURNS TABLE (
  job_name TEXT,
  last_success TIMESTAMP WITH TIME ZONE,
  hours_since_last_run NUMERIC,
  is_healthy BOOLEAN,
  expected_number VARCHAR(2),
  current_number VARCHAR(2),
  mismatch_detected BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  day_of_month INTEGER;
  expected_num VARCHAR(2);
  current_num VARCHAR(2);
BEGIN
  -- Calcular número esperado
  day_of_month := EXTRACT(DAY FROM (CURRENT_TIMESTAMP AT TIME ZONE 'America/Costa_Rica')::DATE);
  expected_num := LPAD(day_of_month::TEXT, 2, '0');
  
  -- Obtener número actual de una restricción automática (si existe)
  SELECT "number" INTO current_num
  FROM "RestrictionRule"
  WHERE "isAutoDate" = TRUE
    AND "isActive" = TRUE
  LIMIT 1;
  
  -- Retornar información de salud
  RETURN QUERY
  SELECT 
    'update_auto_restrictions'::TEXT as job_name,
    MAX(logs.executed_at) FILTER (WHERE logs.status = 'success') as last_success,
    EXTRACT(EPOCH FROM (NOW() - MAX(logs.executed_at) FILTER (WHERE logs.status = 'success'))) / 3600 as hours_since_last_run,
    CASE 
      WHEN MAX(logs.executed_at) FILTER (WHERE logs.status = 'success') > NOW() - INTERVAL '25 hours' THEN TRUE
      ELSE FALSE
    END as is_healthy,
    expected_num as expected_number,
    COALESCE(current_num, 'N/A') as current_number,
    CASE 
      WHEN current_num IS NOT NULL AND current_num != expected_num THEN TRUE
      ELSE FALSE
    END as mismatch_detected
  FROM cron_execution_logs logs
  WHERE logs.job_name = 'update_auto_restrictions'
  GROUP BY logs.job_name;
END;
$$;

-- Schedule cron jobs (only if pg_cron is available)
-- Note: These will fail silently if pg_cron is not available
DO $$
BEGIN
  -- Job principal: ejecutar a medianoche CR (6 AM UTC)
  PERFORM cron.schedule(
    'update_auto_restrictions_daily',
    '0 6 * * *',  -- 6 AM UTC = medianoche CR
    $$SELECT update_auto_date_restrictions();$$
  );
  
  -- Job de verificación: ejecutar cada 6 horas
  PERFORM cron.schedule(
    'verify_auto_restrictions',
    '0 */6 * * *',  -- Cada 6 horas
    $$SELECT verify_auto_restrictions();$$
  );
EXCEPTION
  WHEN OTHERS THEN
    -- Si pg_cron no está disponible, solo registrar un warning
    RAISE NOTICE 'pg_cron no disponible. Los cron jobs deben ser configurados manualmente.';
END;
$$;

