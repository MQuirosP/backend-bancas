-- ============================================================
-- Función: execute_sorteos_auto_open
-- Exportado: 2026-08-27T17:50:39.129Z
-- Fuente: pg_proc (schema: public)
-- ============================================================
DECLARE
  config_record RECORD;
  sorteo_record RECORD;
  opened_count INTEGER := 0;
  error_count INTEGER := 0;
  today_start TIMESTAMP;
  today_end TIMESTAMP;
BEGIN
  -- Obtener configuración
  SELECT * INTO config_record
  FROM "SorteosAutoConfig"
  LIMIT 1;

  -- Si no existe configuración o está deshabilitada, salir
  IF config_record IS NULL OR config_record."autoOpenEnabled" = false THEN
    RETURN;
  END IF;

  -- Calcular rango del día actual en hora CR (UTC-6)
  -- Hora CR 00:00:00 = UTC 06:00:00
  today_start := DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica') AT TIME ZONE 'America/Costa_Rica' AT TIME ZONE 'UTC';
  today_end := today_start + INTERVAL '1 day' - INTERVAL '1 second';

  -- Abrir sorteos SCHEDULED del día
  FOR sorteo_record IN
    SELECT id, name, "scheduledAt"
    FROM "Sorteo"
    WHERE status = 'SCHEDULED'
      AND "isActive" = true
      AND "scheduledAt" >= today_start
      AND "scheduledAt" <= today_end
  LOOP
    BEGIN
      -- Actualizar estado a OPEN
      UPDATE "Sorteo"
      SET status = 'OPEN',
          "updatedAt" = NOW()
      WHERE id = sorteo_record.id
        AND status = 'SCHEDULED'; -- Doble verificación para evitar race conditions

      IF FOUND THEN
        opened_count := opened_count + 1;

        -- Registrar en ActivityLog
        INSERT INTO "ActivityLog" (id, "userId", action, "targetType", "targetId", details, "createdAt")
        VALUES (
          gen_random_uuid(),
          NULL,
          'SORTEO_OPEN',
          'SORTEO',
          sorteo_record.id,
          jsonb_build_object(
            'from', 'SCHEDULED',
            'to', 'OPEN',
            'auto', true
          ),
          NOW()
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      error_count := error_count + 1;
      -- Continuar con el siguiente sorteo
    END;
  END LOOP;

  -- Actualizar configuración con última ejecución
  UPDATE "SorteosAutoConfig"
  SET "lastOpenExecution" = NOW(),
      "lastOpenCount" = opened_count,
      "updatedAt" = NOW()
  WHERE id = config_record.id;

  -- Registrar en cron_execution_logs (si existe)
  BEGIN
    INSERT INTO cron_execution_logs (id, job_name, status, executed_at, affected_rows, error_message)
    VALUES (
      gen_random_uuid(),
      'sorteos_auto_open',
      CASE WHEN error_count = 0 THEN 'success' ELSE 'partial' END,
      NOW(),
      opened_count,
      CASE WHEN error_count > 0 THEN error_count || ' errores' ELSE NULL END
    );
  EXCEPTION WHEN OTHERS THEN
    -- Tabla puede no existir, ignorar
    NULL;
  END;
END;
