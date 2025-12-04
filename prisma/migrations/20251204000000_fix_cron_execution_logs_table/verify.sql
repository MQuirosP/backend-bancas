-- ============================================================
-- VERIFICACIÓN PRE/POST MIGRACIÓN
-- ============================================================
-- Ejecutar este script ANTES y DESPUÉS de aplicar la migración
-- para confirmar que todo está correcto.
-- ============================================================

-- 1. Verificar tabla cron_execution_logs
SELECT 
  CASE 
    WHEN EXISTS (SELECT FROM pg_tables WHERE tablename = 'cron_execution_logs')
    THEN '✅ Tabla cron_execution_logs existe'
    ELSE '❌ Tabla cron_execution_logs NO existe'
  END as tabla_status;

-- 2. Verificar índices
SELECT 
  indexname,
  CASE 
    WHEN indexname IS NOT NULL THEN '✅ Existe'
    ELSE '❌ No existe'
  END as status
FROM (
  VALUES 
    ('idx_cron_logs_job_name'),
    ('idx_cron_logs_status')
) AS expected(indexname)
LEFT JOIN pg_indexes ON pg_indexes.indexname = expected.indexname;

-- 3. Verificar estructura de la tabla (solo si existe)
SELECT 
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_name = 'cron_execution_logs'
ORDER BY ordinal_position;

-- 4. Verificar cron jobs activos
SELECT 
  jobname,
  schedule,
  active,
  CASE 
    WHEN active THEN '✅ Activo'
    ELSE '⚠️ Inactivo'
  END as status
FROM cron.job
WHERE jobname LIKE '%auto_restrictions%';

-- 5. Verificar funciones necesarias
SELECT 
  proname,
  CASE 
    WHEN proname IS NOT NULL THEN '✅ Existe'
    ELSE '❌ No existe'
  END as status
FROM (
  VALUES 
    ('update_auto_date_restrictions'),
    ('verify_auto_restrictions'),
    ('check_cron_health')
) AS expected(proname)
LEFT JOIN pg_proc ON pg_proc.proname = expected.proname;

-- 6. Verificar últimas ejecuciones de cron (solo si tabla existe)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'cron_execution_logs') THEN
    RAISE NOTICE '--- Últimas 5 ejecuciones de cron ---';
    PERFORM * FROM (
      SELECT 
        job_name,
        status,
        executed_at,
        affected_rows,
        effective_number,
        error_message
      FROM cron_execution_logs
      ORDER BY executed_at DESC
      LIMIT 5
    ) AS recent_logs;
  ELSE
    RAISE NOTICE '⚠️ Tabla cron_execution_logs no existe, no se pueden ver logs';
  END IF;
END $$;

-- 7. Verificar salud del sistema (solo si tabla existe)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'cron_execution_logs') THEN
    RAISE NOTICE '--- Salud del sistema de cron ---';
    PERFORM * FROM check_cron_health();
  ELSE
    RAISE NOTICE '⚠️ No se puede verificar salud sin tabla cron_execution_logs';
  END IF;
END $$;

-- 8. Resumen final
SELECT 
  '✅ VERIFICACIÓN COMPLETA' as status,
  NOW() as timestamp;
