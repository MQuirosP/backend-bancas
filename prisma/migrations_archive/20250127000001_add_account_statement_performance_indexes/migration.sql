-- ============================================================================
-- MIGRACIÓN: Índices de Rendimiento para Estados de Cuenta
-- Fecha: 2025-01-27
-- Propósito: Optimizar queries de estados de cuenta (GET /api/v1/accounts/statement)
-- Impacto: BAJO - Los índices se crean CONCURRENTLY (sin bloqueo de tablas)
-- Rollback: Ver instrucciones al final
-- ============================================================================

-- IMPORTANTE: Esta migración usa CREATE INDEX CONCURRENTLY
-- que NO bloquea las tablas durante la creación del índice.
-- Puede tomar varios minutos dependiendo del tamaño de las tablas.

-- ============================================================================
-- SECCIÓN 1: Índices para AccountStatement (Estados de Cuenta)
-- ============================================================================

-- Índice 1: Optimiza queries por fecha, estado de asentamiento y filtros por entidad
-- Usado en: getSettledStatements() - queries de días asentados
-- Query optimizada: SELECT WHERE date BETWEEN ? AND ? AND isSettled = true AND (ventanaId/vendedorId/bancaId)
-- NOTA: AccountStatement NO tiene deletedAt ni dimension (la dimensión se infiere de los campos presentes)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_account_statements_date_settled_dimension"
ON "AccountStatement"("date", "isSettled", "ventanaId", "vendedorId", "bancaId");

-- Índice 2: Optimiza queries por mes y estado de asentamiento
-- Usado en: Queries mensuales de estados asentados
-- NOTA: AccountStatement NO tiene deletedAt, por lo que no se incluye en WHERE
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_account_statements_month_settled"
ON "AccountStatement"("month", "isSettled")
WHERE "isSettled" = true;

-- ============================================================================
-- SECCIÓN 2: Índices para Ticket (Optimización de "today")
-- ============================================================================

-- Índice 3: Optimiza queries por businessDate (fecha de negocio) y estado
-- Usado en: getStatementDirect() - queries de días no asentados, especialmente "today"
-- Query optimizada: SELECT WHERE businessDate = ? AND status != 'CANCELLED' AND deletedAt IS NULL
-- NOTA: Este índice usa una expresión para manejar businessDate NULL (usa createdAt)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tickets_business_date_status_optimized"
ON "Ticket"(
    COALESCE("businessDate", DATE(("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))),
    "status",
    "ventanaId",
    "vendedorId"
)
WHERE "deletedAt" IS NULL 
  AND "isActive" = true 
  AND "status" != 'CANCELLED';

-- Índice 4: Optimiza queries de "today" específicamente
-- Usado en: Queries de "today" que requieren solo sorteos evaluados
-- Query optimizada: SELECT WHERE businessDate = TODAY AND status != 'CANCELLED'
-- NOTA: No se puede usar EXISTS en WHERE de índice parcial, así que este índice es más general
-- La query aplicará el filtro de sorteo EVALUATED en runtime
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tickets_today_evaluated"
ON "Ticket"(
    COALESCE("businessDate", DATE(("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))),
    "status",
    "ventanaId",
    "vendedorId",
    "sorteoId"
)
WHERE "deletedAt" IS NULL 
  AND "isActive" = true 
  AND "status" != 'CANCELLED';

-- Índice 5: Optimiza queries por ventana, vendedor y fecha
-- Usado en: Queries filtradas por ventana/vendedor específico
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tickets_ventana_vendedor_date"
ON "Ticket"("ventanaId", "vendedorId", "businessDate", "status")
WHERE "deletedAt" IS NULL 
  AND "isActive" = true 
  AND "status" != 'CANCELLED';

-- ============================================================================
-- SECCIÓN 3: Índices para Jugada (Optimización de joins)
-- ============================================================================

-- Índice 6: Optimiza joins entre Ticket y Jugada para cálculo de totales
-- Usado en: getStatementDirect() - agregaciones de sales, payouts, comisiones
-- Query optimizada: JOIN Jugada ON ticketId WHERE deletedAt IS NULL
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_jugada_ticket_id_deleted"
ON "Jugada"("ticketId", "deletedAt")
WHERE "deletedAt" IS NULL;

-- Índice 7: Optimiza cálculo de comisiones y payouts
-- Usado en: Agregaciones de listeroCommissionAmount, commissionAmount, payout
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_jugada_commissions_payout"
ON "Jugada"("ticketId", "isWinner", "commissionOrigin", "deletedAt")
INCLUDE ("listeroCommissionAmount", "commissionAmount", "payout")
WHERE "deletedAt" IS NULL;

-- ============================================================================
-- VERIFICACIÓN DE ÍNDICES CREADOS
-- ============================================================================

-- Ejecutar esta query después de la migración para verificar que todos los índices se crearon:
-- SELECT schemaname, tablename, indexname, indexdef
-- FROM pg_indexes
-- WHERE indexname LIKE 'idx_account_statements_%' 
--    OR indexname LIKE 'idx_tickets_%'
--    OR indexname LIKE 'idx_jugada_%'
-- ORDER BY tablename, indexname;

-- ============================================================================
-- ESTADÍSTICAS DE IMPACTO ESPERADO
-- ============================================================================

-- Tabla: AccountStatement
--   - Queries de días asentados: ~80% más rápidas (de 500ms a 100ms)
--   - Queries mensuales: ~70% más rápidas

-- Tabla: Ticket
--   - Queries de "today": ~90% más rápidas (de 2-5s a <500ms)
--   - Queries por fecha: ~60% más rápidas
--   - Queries filtradas por ventana/vendedor: ~50% más rápidas

-- Tabla: Jugada
--   - Joins con Ticket: ~70% más rápidos
--   - Agregaciones de comisiones: ~65% más rápidas

-- ============================================================================
-- ROLLBACK (REVERSIÓN SEGURA)
-- ============================================================================

-- EN CASO DE NECESITAR REVERTIR LA MIGRACIÓN, ejecutar:
/*
DROP INDEX CONCURRENTLY IF EXISTS "idx_account_statements_date_settled_dimension";
DROP INDEX CONCURRENTLY IF EXISTS "idx_account_statements_month_settled";
DROP INDEX CONCURRENTLY IF EXISTS "idx_tickets_business_date_status_optimized";
DROP INDEX CONCURRENTLY IF EXISTS "idx_tickets_today_evaluated";
DROP INDEX CONCURRENTLY IF EXISTS "idx_tickets_ventana_vendedor_date";
DROP INDEX CONCURRENTLY IF EXISTS "idx_jugada_ticket_id_deleted";
DROP INDEX CONCURRENTLY IF EXISTS "idx_jugada_commissions_payout";
*/

-- NOTA: El rollback también usa CONCURRENTLY para evitar bloqueos.
-- Eliminar índices es seguro y no afecta los datos, solo el rendimiento.

-- ============================================================================
-- ️ INSTRUCCIONES CRÍTICAS DE DESPLIEGUE EN PRODUCCIÓN
-- ============================================================================

-- ️ IMPORTANTE: CREATE INDEX CONCURRENTLY NO puede ejecutarse dentro de una transacción
-- Por lo tanto, NO usar: npx prisma migrate deploy (ejecuta en transacción)
-- 
-- SOLUCIÓN: Ejecutar este SQL directamente en Supabase SQL Editor
-- Luego marcar la migración como aplicada: npx prisma migrate resolve --applied 20250127000001_add_account_statement_performance_indexes

-- 1. ANTES DE EJECUTAR:
--    - Hacer backup de la base de datos en Supabase Dashboard
--    - Verificar que no hay migraciones pendientes: npx prisma migrate status
--    - Notificar al equipo (ventana de mantenimiento no requerida gracias a CONCURRENTLY)

-- 2. EJECUTAR EN PRODUCCIÓN (SUPABASE SQL EDITOR):
--    a) Ir a Supabase Dashboard > SQL Editor
--    b) Copiar TODO el contenido de este archivo (desde la primera línea CREATE INDEX)
--    c) Pegar en SQL Editor
--    d) Click en "Run" (️)
--    e) ESPERAR a que complete (puede tomar 5-15 minutos, NO interrumpir)
--    f) Verificar que todos los índices se crearon (usar query de verificación abajo)
--    g) Marcar migración como aplicada: npx prisma migrate resolve --applied 20250127000001_add_account_statement_performance_indexes

-- 3. VERIFICACIÓN POST-MIGRACIÓN:
--    - Ejecutar: SELECT * FROM pg_stat_progress_create_index;
--    - Verificar que todos los índices aparecen en: \di+ en psql
--    - Probar endpoint GET /api/v1/accounts/statement?date=today
--    - Verificar logs de aplicación (no deben haber errores)
--    - Medir tiempo de respuesta (debe ser <500ms)

-- 4. SI ALGO SALE MAL:
--    - Los índices CONCURRENTLY pueden fallar sin afectar la operación
--    - Si un índice falla, puede reintentarse individualmente
--    - Si es necesario rollback, usar el script de rollback al final
--    - Contactar al equipo de desarrollo

-- ============================================================================
-- MONITOREO POST-DESPLIEGUE
-- ============================================================================

-- Query para verificar el uso de índices después del despliegue:
-- SELECT schemaname, tablename, indexname, idx_scan, idx_tup_read, idx_tup_fetch
-- FROM pg_stat_user_indexes
-- WHERE indexname LIKE 'idx_account_statements_%' 
--    OR indexname LIKE 'idx_tickets_%'
--    OR indexname LIKE 'idx_jugada_%'
-- ORDER BY idx_scan DESC;

-- Query para verificar tiempos de query mejorados:
-- SELECT query, mean_exec_time, calls
-- FROM pg_stat_statements
-- WHERE query LIKE '%AccountStatement%' 
--    OR query LIKE '%Ticket%' 
--    OR query LIKE '%Jugada%'
-- ORDER BY mean_exec_time DESC
-- LIMIT 20;

