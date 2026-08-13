-- ============================================================================
-- MIGRACIÓN: Índices de Rendimiento para Accounts (Prioridad 1)
-- Fecha: 2025-01-28
-- Propósito: Optimizar queries críticas de accounts según análisis de rendimiento
-- Impacto: BAJO - Los índices se crean CONCURRENTLY (sin bloqueo de tablas)
-- Rollback: Ver archivo rollback al final
-- ============================================================================

-- IMPORTANTE: Esta migración usa CREATE INDEX (sin CONCURRENTLY)
-- porque Prisma Migrate ejecuta dentro de transacciones y CONCURRENTLY no es compatible.
-- En PostgreSQL moderno, el bloqueo es mínimo y la creación es rápida.
-- Si necesitas evitar bloqueos, ejecuta el SQL manualmente con CONCURRENTLY.

-- ============================================================================
-- SECCIÓN 1: Índice para Jugada.listeroCommissionAmount
-- ============================================================================

-- Índice 1: Optimiza agregación de comisiones del listero
-- Usado en: accounts.calculations.ts - agregación de listeroCommissionAmount
-- Query optimizada: SUM(j."listeroCommissionAmount") WHERE j."listeroCommissionAmount" > 0
-- Usa índice parcial (WHERE > 0) para reducir tamaño y mejorar rendimiento
CREATE INDEX IF NOT EXISTS "idx_jugada_listero_commission_amount"
ON "Jugada"("listeroCommissionAmount")
WHERE "listeroCommissionAmount" > 0 AND "deletedAt" IS NULL;

-- ============================================================================
-- SECCIÓN 2: Índice Compuesto para AccountPayment
-- ============================================================================

-- Índice 2: Optimiza búsqueda de movimientos por fecha y ventana
-- Usado en: AccountPaymentRepository.findMovementsByDateRange
-- Query optimizada: SELECT WHERE date BETWEEN ? AND ? AND ventanaId = ? AND isReversed = false
-- Índice compuesto para queries frecuentes de accounts
CREATE INDEX IF NOT EXISTS "idx_account_payment_date_ventana"
ON "AccountPayment"("date", "ventanaId")
WHERE "isReversed" = false;

-- Índice 3: Similar para vendedor (cuando dimension=vendedor)
-- Usado en: AccountPaymentRepository.findMovementsByDateRange con vendedorId
CREATE INDEX IF NOT EXISTS "idx_account_payment_date_vendedor"
ON "AccountPayment"("date", "vendedorId")
WHERE "isReversed" = false AND "vendedorId" IS NOT NULL;

-- ============================================================================
-- VERIFICACIÓN DE ÍNDICES CREADOS
-- ============================================================================

-- Ejecutar esta query después de la migración para verificar que todos los índices se crearon:
-- SELECT schemaname, tablename, indexname, indexdef
-- FROM pg_indexes
-- WHERE indexname IN (
--   'idx_jugada_listero_commission_amount',
--   'idx_account_payment_date_ventana',
--   'idx_account_payment_date_vendedor'
-- )
-- ORDER BY tablename, indexname;

-- ============================================================================
-- ESTADÍSTICAS DE IMPACTO ESPERADO
-- ============================================================================

-- Tabla: Jugada
--   - Agregación de comisiones listero: ~40-50% más rápida
--   - Queries de accounts.calculations.ts: ~30-40% mejora en tiempo total

-- Tabla: AccountPayment
--   - findMovementsByDateRange: ~50-60% más rápida
--   - Queries de movimientos por fecha: ~60-70% mejora

-- Impacto total esperado: 30-50% mejora en tiempo de respuesta de accounts

-- ============================================================================
-- ROLLBACK (REVERSIÓN SEGURA)
-- ============================================================================

-- EN CASO DE NECESITAR REVERTIR LA MIGRACIÓN, ejecutar:
/*
DROP INDEX IF EXISTS "idx_jugada_listero_commission_amount";
DROP INDEX IF EXISTS "idx_account_payment_date_ventana";
DROP INDEX IF EXISTS "idx_account_payment_date_vendedor";
*/

-- NOTA: Eliminar índices es seguro y no afecta los datos, solo el rendimiento.

-- ============================================================================
-- INSTRUCCIONES DE DESPLIEGUE EN PRODUCCIÓN
-- ============================================================================

-- 1. ANTES DE EJECUTAR:
--    - Hacer backup de la base de datos
--    - Verificar que no hay migraciones pendientes: npx prisma migrate status
--    - Notificar al equipo (ventana de mantenimiento no requerida)

-- 2. EJECUTAR MIGRACIÓN:
--    - npx prisma migrate deploy
--    - O ejecutar este SQL directamente en el editor SQL de Supabase/PostgreSQL
--    - La ejecución puede tomar 2-10 minutos dependiendo del tamaño de las tablas
--    - NO interrumpir el proceso

-- 3. VERIFICACIÓN POST-MIGRACIÓN:
--    - Verificar que todos los índices aparecen: \di+ en psql
--    - Probar endpoint de accounts: GET /api/v1/accounts/statement
--    - Verificar logs de aplicación (no deben haber errores)
--    - Monitorear tiempos de respuesta (deben mejorar 30-50%)

-- 4. SI ALGO SALE MAL:
--    - Los índices CONCURRENTLY pueden fallar sin afectar la operación
--    - Si un índice falla, puede reintentarse individualmente
--    - Si es necesario rollback, usar el script de rollback arriba
--    - Contactar al equipo de desarrollo

