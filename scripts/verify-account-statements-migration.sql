-- Script de verificación ANTES de aplicar la migración de Account Statements
-- Ejecutar este script en producción para verificar que todo está correcto
-- NO aplica cambios, solo verifica

-- 1. Verificar que las tablas NO existen (para evitar conflictos)
SELECT 
  CASE 
    WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'AccountStatement') 
    THEN 'ERROR: AccountStatement ya existe'
    ELSE 'OK: AccountStatement no existe'
  END as account_statement_check;

SELECT 
  CASE 
    WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'AccountPayment') 
    THEN 'ERROR: AccountPayment ya existe'
    ELSE 'OK: AccountPayment no existe'
  END as account_payment_check;

-- 2. Verificar que las tablas relacionadas existen
SELECT 
  CASE 
    WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'Ventana') 
    THEN 'OK: Ventana existe'
    ELSE 'ERROR: Ventana no existe'
  END as ventana_check;

SELECT 
  CASE 
    WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'User') 
    THEN 'OK: User existe'
    ELSE 'ERROR: User no existe'
  END as user_check;

-- 3. Verificar que las columnas necesarias existen en Ventana y User
SELECT 
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_name = 'Ventana' AND column_name = 'id'
    )
    THEN 'OK: Ventana.id existe'
    ELSE 'ERROR: Ventana.id no existe'
  END as ventana_id_check;

SELECT 
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_name = 'User' AND column_name = 'id'
    )
    THEN 'OK: User.id existe'
    ELSE 'ERROR: User.id no existe'
  END as user_id_check;

-- 4. Verificar que UUID está disponible como función
SELECT 
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM pg_proc 
      WHERE proname = 'gen_random_uuid'
    )
    THEN 'OK: gen_random_uuid() disponible'
    ELSE 'ERROR: gen_random_uuid() no disponible - necesitas habilitar pgcrypto'
  END as uuid_check;

-- 5. Verificar permisos básicos (necesita CREATE TABLE, CREATE INDEX, etc.)
SELECT 
  current_user as current_db_user,
  current_database() as current_database;

-- 6. Resumen final
SELECT 
  'Verificación completada. Revisa los resultados arriba.' as message,
  'Si todos los checks son OK, puedes proceder con la migración.' as next_step;

