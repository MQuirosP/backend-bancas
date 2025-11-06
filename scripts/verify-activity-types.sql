-- Script para verificar si los nuevos ActivityType están en la base de datos
-- Ejecutar este script para verificar el estado del enum

SELECT 
  enumlabel as activity_type,
  enumsortorder as sort_order
FROM pg_enum
WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'ActivityType')
ORDER BY enumsortorder;

-- Verificar específicamente los nuevos valores
SELECT 
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM pg_enum 
      WHERE enumlabel = 'ACCOUNT_STATEMENT_VIEW' 
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'ActivityType')
    ) THEN 'OK: ACCOUNT_STATEMENT_VIEW existe'
    ELSE 'ERROR: ACCOUNT_STATEMENT_VIEW NO existe'
  END as account_statement_view_check;

SELECT 
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM pg_enum 
      WHERE enumlabel = 'ACCOUNT_PAYMENT_CREATE' 
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'ActivityType')
    ) THEN 'OK: ACCOUNT_PAYMENT_CREATE existe'
    ELSE 'ERROR: ACCOUNT_PAYMENT_CREATE NO existe'
  END as account_payment_create_check;

SELECT 
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM pg_enum 
      WHERE enumlabel = 'ACCOUNT_PAYMENT_REVERSE' 
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'ActivityType')
    ) THEN 'OK: ACCOUNT_PAYMENT_REVERSE existe'
    ELSE 'ERROR: ACCOUNT_PAYMENT_REVERSE NO existe'
  END as account_payment_reverse_check;

SELECT 
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM pg_enum 
      WHERE enumlabel = 'ACCOUNT_PAYMENT_HISTORY_VIEW' 
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'ActivityType')
    ) THEN 'OK: ACCOUNT_PAYMENT_HISTORY_VIEW existe'
    ELSE 'ERROR: ACCOUNT_PAYMENT_HISTORY_VIEW NO existe'
  END as account_payment_history_view_check;

