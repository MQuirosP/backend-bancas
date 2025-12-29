-- ============================================================================
-- MIGRACIÓN: Índices Faltantes para Optimización de Queries
-- Fecha: 2025-01-30
-- Propósito: Agregar índices faltantes identificados en análisis de optimización
-- Impacto: BAJO - Los índices se crean CONCURRENTLY (sin bloqueo de tablas)
-- ============================================================================

-- IMPORTANTE: Esta migración usa CREATE INDEX CONCURRENTLY
-- que NO bloquea las tablas durante la creación del índice.
-- Puede tomar varios minutos dependiendo del tamaño de las tablas.

-- ============================================================================
-- ÍNDICE 1: Jugadas Ganadoras (Optimiza cálculo de payouts)
-- ============================================================================

-- Optimiza queries que calculan payouts sumando jugadas ganadoras
-- Usado en: getSorteoBreakdownBatch - cálculo de payouts por sorteo
-- Query optimizada: SELECT SUM(payout) WHERE ticketId = ? AND isWinner = true AND deletedAt IS NULL
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_jugada_ticket_winner"
ON "Jugada"("ticketId", "isWinner", "deletedAt")
INCLUDE ("payout")
WHERE "deletedAt" IS NULL AND "isWinner" = true;

-- ============================================================================
-- ÍNDICE 2: Exclusión de Listas (Optimiza NOT EXISTS en queries)
-- ============================================================================

-- Optimiza verificación de exclusiones en queries de tickets
-- Usado en: getStatementDirect, getSorteoBreakdownBatch - filtro NOT EXISTS
-- Query optimizada: NOT EXISTS (SELECT 1 FROM sorteo_lista_exclusion WHERE sorteo_id = ? AND ventana_id = ? AND vendedor_id = ?)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_sorteo_lista_exclusion_lookup"
ON "sorteo_lista_exclusion"("sorteo_id", "ventana_id", "vendedor_id");

-- ============================================================================
-- ÍNDICE 3: AccountPayment por Banca (Falta para dimension=banca)
-- ============================================================================

-- Optimiza búsqueda de movimientos por fecha y banca
-- Usado en: AccountPaymentRepository.findMovementsByDateRange con bancaId
-- Query optimizada: SELECT WHERE date BETWEEN ? AND ? AND bancaId = ? AND isReversed = false
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_account_payment_date_banca"
ON "AccountPayment"("date", "bancaId", "isReversed")
WHERE "isReversed" = false AND "bancaId" IS NOT NULL;

-- ============================================================================
-- VERIFICACIÓN DE ÍNDICES CREADOS
-- ============================================================================

-- Ejecutar esta query después de la migración para verificar:
-- SELECT schemaname, tablename, indexname, indexdef
-- FROM pg_indexes
-- WHERE indexname IN (
--   'idx_jugada_ticket_winner',
--   'idx_sorteo_lista_exclusion_lookup',
--   'idx_account_payment_date_banca'
-- )
-- ORDER BY tablename, indexname;

-- ============================================================================
-- ESTADÍSTICAS DE IMPACTO ESPERADO
-- ============================================================================

-- Tabla: Jugada
--   - Cálculo de payouts: ~30-40% más rápido
--   - Queries de getSorteoBreakdownBatch: ~20-30% mejora

-- Tabla: sorteo_lista_exclusion
--   - Verificación de exclusiones: ~50-60% más rápido
--   - Queries con NOT EXISTS: ~40-50% mejora

-- Tabla: AccountPayment
--   - Búsqueda por banca: ~50-60% más rápido
--   - Queries de movimientos: ~30-40% mejora

-- ============================================================================
-- ROLLBACK (REVERSIÓN SEGURA)
-- ============================================================================

-- EN CASO DE NECESITAR REVERTIR LA MIGRACIÓN, ejecutar:
/*
DROP INDEX CONCURRENTLY IF EXISTS "idx_jugada_ticket_winner";
DROP INDEX CONCURRENTLY IF EXISTS "idx_sorteo_lista_exclusion_lookup";
DROP INDEX CONCURRENTLY IF EXISTS "idx_account_payment_date_banca";
*/

-- NOTA: El rollback también usa CONCURRENTLY para evitar bloqueos.
-- Eliminar índices es seguro y no afecta los datos, solo el rendimiento.

-- ============================================================================
-- ⚠️ INSTRUCCIONES CRÍTICAS DE DESPLIEGUE EN PRODUCCIÓN
-- ============================================================================

-- ⚠️ IMPORTANTE: CREATE INDEX CONCURRENTLY NO puede ejecutarse dentro de una transacción
-- Por lo tanto, NO usar: npx prisma migrate deploy (ejecuta en transacción)
-- 
-- SOLUCIÓN: Ejecutar este SQL directamente en Supabase SQL Editor
-- Luego marcar la migración como aplicada: npx prisma migrate resolve --applied 20250130000000_add_missing_performance_indexes

-- 1. ANTES DE EJECUTAR:
--    - Hacer backup de la base de datos en Supabase Dashboard
--    - Verificar que no hay migraciones pendientes: npx prisma migrate status
--    - Notificar al equipo (ventana de mantenimiento no requerida gracias a CONCURRENTLY)

-- 2. EJECUTAR EN PRODUCCIÓN (SUPABASE SQL EDITOR):
--    a) Ir a Supabase Dashboard > SQL Editor
--    b) Copiar TODO el contenido de este archivo (desde la primera línea CREATE INDEX)
--    c) Pegar en SQL Editor
--    d) Click en "Run" (▶️)
--    e) ESPERAR a que complete (puede tomar 5-15 minutos, NO interrumpir)
--    f) Verificar que todos los índices se crearon (usar query de verificación arriba)
--    g) Marcar migración como aplicada: npx prisma migrate resolve --applied 20250130000000_add_missing_performance_indexes

-- 3. VERIFICACIÓN POST-MIGRACIÓN:
--    - Ejecutar: SELECT * FROM pg_stat_progress_create_index;
--    - Verificar que todos los índices aparecen en: \di+ en psql
--    - Probar endpoint GET /api/v1/accounts/statement?date=today
--    - Verificar logs de aplicación (no deben haber errores)
--    - Medir tiempo de respuesta (debe mejorar 20-40%)

