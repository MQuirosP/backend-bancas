--  CRÍTICO: Eliminar constraints _one_relation_check de AccountPayment y AccountStatement
-- 
-- Estos constraints impedían que ambos ventanaId y vendedorId estuvieran presentes simultáneamente.
-- Al eliminarlos, permitimos que:
-- - Los movimientos (AccountPayment) puedan tener ambos campos para mantener integridad histórica
-- - Los estados de cuenta (AccountStatement) puedan tener ambos campos cuando corresponda
-- 
-- MIGRACIÓN SEGURA PARA PRODUCCIÓN:
-- - Usa IF EXISTS para evitar errores si el constraint ya no existe
-- - Los constraints únicos parciales existentes ya protegen la integridad de los datos
-- - No afecta datos existentes (solo elimina una restricción)

-- Paso 1: Eliminar constraint de AccountStatement
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'AccountStatement_one_relation_check'
    AND conrelid = (SELECT oid FROM pg_class WHERE relname = 'AccountStatement')
  ) THEN
    ALTER TABLE "AccountStatement" 
    DROP CONSTRAINT "AccountStatement_one_relation_check";
    
    RAISE NOTICE 'Constraint AccountStatement_one_relation_check eliminado exitosamente';
  ELSE
    RAISE NOTICE 'Constraint AccountStatement_one_relation_check no existe, saltando...';
  END IF;
END $$;

-- Paso 2: Eliminar constraint de AccountPayment
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'AccountPayment_one_relation_check'
    AND conrelid = (SELECT oid FROM pg_class WHERE relname = 'AccountPayment')
  ) THEN
    ALTER TABLE "AccountPayment" 
    DROP CONSTRAINT "AccountPayment_one_relation_check";
    
    RAISE NOTICE 'Constraint AccountPayment_one_relation_check eliminado exitosamente';
  ELSE
    RAISE NOTICE 'Constraint AccountPayment_one_relation_check no existe, saltando...';
  END IF;
END $$;

--  NOTA: Los constraints únicos parciales existentes ya protegen la integridad:
-- - account_statements_date_ventana_unique: (date, ventanaId) WHERE ventanaId IS NOT NULL
-- - account_statements_date_vendedor_unique: (date, vendedorId) WHERE vendedorId IS NOT NULL
-- 
-- Estos constraints parciales permiten que ambos campos estén presentes simultáneamente
-- mientras mantienen la unicidad por fecha+dimensión cuando corresponda.
-- 
-- Esta migración es segura y puede ejecutarse múltiples veces sin problemas

