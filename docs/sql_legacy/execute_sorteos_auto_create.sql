-- ============================================================
-- Función: execute_sorteos_auto_create
-- Exportado: 2026-08-27T17:50:39.128Z
-- Fuente: pg_proc (schema: public)
-- ============================================================
DECLARE
  config_record RECORD;
  loteria_record RECORD;
  rules_json JSONB;
  schedule_json JSONB;
  times_array TEXT[];
  days_ahead INTEGER := 7;
  start_date TIMESTAMP;
  created_count INTEGER := 0;
  error_count INTEGER := 0;
BEGIN
  -- Obtener configuración
  SELECT * INTO config_record
  FROM "SorteosAutoConfig"
  LIMIT 1;

  -- Si no existe configuración o está deshabilitada, salir
  IF config_record IS NULL OR config_record."autoCreateEnabled" = false THEN
    RETURN;
  END IF;

  -- Fecha de inicio: hoy en hora CR
  start_date := DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica') AT TIME ZONE 'America/Costa_Rica' AT TIME ZONE 'UTC';

  -- Procesar cada lotería activa
  FOR loteria_record IN
    SELECT id, name, "rulesJson"
    FROM "Loteria"
    WHERE "isActive" = true
      AND "rulesJson" IS NOT NULL
  LOOP
    BEGIN
      rules_json := loteria_record."rulesJson";

      -- Verificar flag autoCreateSorteos
      IF (rules_json->>'autoCreateSorteos')::boolean = false THEN
        CONTINUE;
      END IF;

      -- Obtener drawSchedule
      schedule_json := rules_json->'drawSchedule';
      IF schedule_json IS NULL THEN
        CONTINUE;
      END IF;

      -- Obtener array de times
      times_array := ARRAY(SELECT jsonb_array_elements_text(schedule_json->'times'));
      IF array_length(times_array, 1) IS NULL THEN
        CONTINUE;
      END IF;

      -- Por ahora, la creación masiva se hace desde Node.js
      -- Esta función SQL solo registra la ejecución
      -- La lógica completa está en sorteosAuto.service.ts

    EXCEPTION WHEN OTHERS THEN
      error_count := error_count + 1;
      -- Continuar con la siguiente lotería
    END;
  END LOOP;

  -- Actualizar configuración con última ejecución
  UPDATE "SorteosAutoConfig"
  SET "lastCreateExecution" = NOW(),
      "lastCreateCount" = created_count,
      "updatedAt" = NOW()
  WHERE id = config_record.id;

  -- Registrar en cron_execution_logs (si existe)
  BEGIN
    INSERT INTO cron_execution_logs (id, job_name, status, executed_at, affected_rows, error_message)
    VALUES (
      gen_random_uuid(),
      'sorteos_auto_create',
      CASE WHEN error_count = 0 THEN 'success' ELSE 'partial' END,
      NOW(),
      created_count,
      CASE WHEN error_count > 0 THEN error_count || ' errores' ELSE NULL END
    );
  EXCEPTION WHEN OTHERS THEN
    -- Tabla puede no existir, ignorar
    NULL;
  END;
END;
