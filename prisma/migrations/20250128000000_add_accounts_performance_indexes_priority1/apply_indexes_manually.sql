-- ============================================================================
-- EJECUTAR MANUALMENTE: Crear índices de rendimiento para Accounts
-- ============================================================================
-- Este script debe ejecutarse manualmente en el editor SQL de Supabase/PostgreSQL
-- porque Prisma Migrate no soporta CREATE INDEX CONCURRENTLY en transacciones.
--
-- INSTRUCCIONES:
-- 1. Abrir editor SQL de Supabase
-- 2. Copiar y pegar este script completo
-- 3. Ejecutar
-- 4. Verificar que los índices se crearon (query al final)
-- ============================================================================

-- Índice 1: Optimiza agregación de comisiones del listero
CREATE INDEX IF NOT EXISTS "idx_jugada_listero_commission_amount"
ON "Jugada"("listeroCommissionAmount")
WHERE "listeroCommissionAmount" > 0 AND "deletedAt" IS NULL;

-- Índice 2: Optimiza búsqueda de movimientos por fecha y ventana
CREATE INDEX IF NOT EXISTS "idx_account_payment_date_ventana"
ON "AccountPayment"("date", "ventanaId")
WHERE "isReversed" = false;

-- Índice 3: Optimiza búsqueda de movimientos por fecha y vendedor
CREATE INDEX IF NOT EXISTS "idx_account_payment_date_vendedor"
ON "AccountPayment"("date", "vendedorId")
WHERE "isReversed" = false AND "vendedorId" IS NOT NULL;

-- ============================================================================
-- VERIFICACIÓN: Ejecutar esta query para confirmar que los índices se crearon
-- ============================================================================
SELECT 
    schemaname, 
    tablename, 
    indexname, 
    indexdef
FROM pg_indexes
WHERE indexname IN (
    'idx_jugada_listero_commission_amount',
    'idx_account_payment_date_ventana',
    'idx_account_payment_date_vendedor'
)
ORDER BY tablename, indexname;

-- Debe mostrar 3 índices creados.

