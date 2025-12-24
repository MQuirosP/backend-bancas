-- ✅ CRÍTICO: Agregar bancaId a AccountPayment para persistir la banca directamente
-- Esto evita problemas cuando un vendedor cambia de ventana o una ventana cambia de banca
-- Los movimientos históricos deben mantener la banca/ventana original
-- 
-- MIGRACIÓN SEGURA PARA PRODUCCIÓN:
-- - Usa IF NOT EXISTS para evitar errores si ya existe
-- - Verifica existencia de constraint antes de agregarlo
-- - No afecta datos existentes (columna nullable)

-- Paso 1: Agregar columna bancaId (nullable inicialmente, se actualizará con script de migración de datos)
ALTER TABLE "AccountPayment" 
ADD COLUMN IF NOT EXISTS "bancaId" UUID;

-- Paso 2: Crear índice para bancaId (crítico para filtros por banca)
-- Safe: IF NOT EXISTS evita errores si el índice ya existe
CREATE INDEX IF NOT EXISTS "AccountPayment_bancaId_idx" ON "AccountPayment"("bancaId");

-- Paso 3: Agregar foreign key constraint a Banca (con verificación de existencia)
-- Safe: Verifica si el constraint ya existe antes de intentar crearlo
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'AccountPayment'
    AND c.conname = 'AccountPayment_bancaId_fkey'
  ) THEN
    ALTER TABLE "AccountPayment" 
    ADD CONSTRAINT "AccountPayment_bancaId_fkey" 
    FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ✅ NOTA: Los datos existentes se actualizarán con el script de migración de datos
-- (inferir ventanaId desde vendedorId y bancaId desde ventanaId)
-- 
-- Esta migración es segura y puede ejecutarse múltiples veces sin problemas

