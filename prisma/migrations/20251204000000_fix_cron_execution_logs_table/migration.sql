-- ============================================================
-- REPARACIÓN: Crear tabla cron_execution_logs faltante
-- ============================================================
-- Esta tabla debería haberse creado en la migración
-- 20251116000000_add_cron_auto_date_restrictions pero falló
-- en el primer intento y no se creó en el segundo.
--
-- Fecha: 2025-12-04
-- Ambiente: Producción
-- Riesgo: BAJO (solo crea tabla si no existe)
-- ============================================================

-- Crear tabla de logs de ejecución de cron jobs
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

-- Crear índices para búsquedas rápidas
CREATE INDEX IF NOT EXISTS idx_cron_logs_job_name 
  ON cron_execution_logs(job_name, executed_at DESC);

CREATE INDEX IF NOT EXISTS idx_cron_logs_status 
  ON cron_execution_logs(status, executed_at DESC);

-- Comentario para documentación
COMMENT ON TABLE cron_execution_logs IS 'Registro de ejecuciones de cron jobs automáticos (restricciones auto-date). Creado en migración de reparación 20251204000000_fix_cron_execution_logs_table.';

-- ============================================================
-- VERIFICACIÓN POST-CREACIÓN
-- ============================================================
-- Insertar registro inicial para verificar que todo funciona
INSERT INTO cron_execution_logs (
  job_name,
  status,
  executed_at,
  affected_rows,
  effective_number
) VALUES (
  'migration_repair',
  'success',
  NOW(),
  0,
  LPAD(EXTRACT(DAY FROM (CURRENT_TIMESTAMP AT TIME ZONE 'America/Costa_Rica')::DATE)::TEXT, 2, '0')
);

-- Log de éxito
DO $$
BEGIN
  RAISE NOTICE ' Tabla cron_execution_logs creada exitosamente';
  RAISE NOTICE ' Registro inicial insertado';
  RAISE NOTICE ' Migración de reparación completada';
END $$;
