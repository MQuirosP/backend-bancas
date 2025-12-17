-- ============================================================================
-- ROLLBACK: Reversión de Índices de Rendimiento
-- Fecha: 2025-12-16
-- Propósito: Revertir la migración 20251216214500_add_performance_indexes
-- ============================================================================

-- IMPORTANTE: Este script es completamente seguro de ejecutar en producción
-- - Usa DROP INDEX CONCURRENTLY para evitar bloqueos
-- - No afecta los datos, solo el rendimiento
-- - Puede ejecutarse en cualquier momento sin downtime

-- ============================================================================
-- ELIMINACIÓN DE ÍNDICES (en orden inverso a la creación)
-- ============================================================================

-- Índice 10: Usuarios por ventana y rol
DROP INDEX CONCURRENTLY IF EXISTS "idx_user_ventana_role_active";

-- Índice 9: Restricciones por número específico
DROP INDEX CONCURRENTLY IF EXISTS "idx_restriction_number_active";

-- Índice 8: Restricciones activas por scope
DROP INDEX CONCURRENTLY IF EXISTS "idx_restriction_active_scopes";

-- Índice 7: Sorteos evaluados por fecha
DROP INDEX CONCURRENTLY IF EXISTS "idx_sorteo_evaluated_scheduled";

-- Índice 6: Sorteos OPEN próximos
DROP INDEX CONCURRENTLY IF EXISTS "idx_sorteo_status_scheduled";

-- Índice 5: Jugadas por ticket activas
DROP INDEX CONCURRENTLY IF EXISTS "idx_jugada_ticket_active";

-- Índice 4: Jugadas por número y monto
DROP INDEX CONCURRENTLY IF EXISTS "idx_jugada_number_amount_active";

-- Índice 3: Tickets por businessDate
DROP INDEX CONCURRENTLY IF EXISTS "idx_ticket_business_date_sorteo";

-- Índice 2: Tickets por ventana y estado
DROP INDEX CONCURRENTLY IF EXISTS "idx_ticket_ventana_status_active";

-- Índice 1: Tickets por sorteo y estado
DROP INDEX CONCURRENTLY IF EXISTS "idx_ticket_sorteo_active_status";

-- ============================================================================
-- VERIFICACIÓN DE ROLLBACK
-- ============================================================================

-- Ejecutar esta query para verificar que todos los índices fueron eliminados:
SELECT schemaname, tablename, indexname
FROM pg_indexes
WHERE indexname LIKE 'idx_%'
  AND indexname IN (
    'idx_ticket_sorteo_active_status',
    'idx_ticket_ventana_status_active',
    'idx_ticket_business_date_sorteo',
    'idx_jugada_number_amount_active',
    'idx_jugada_ticket_active',
    'idx_sorteo_status_scheduled',
    'idx_sorteo_evaluated_scheduled',
    'idx_restriction_active_scopes',
    'idx_restriction_number_active',
    'idx_user_ventana_role_active'
  )
ORDER BY tablename, indexname;

-- Si esta query no retorna resultados, el rollback fue exitoso.

-- ============================================================================
-- NOTAS IMPORTANTES
-- ============================================================================

-- 1. Este rollback NO afecta los datos, solo el rendimiento
-- 2. Después del rollback, las queries volverán a su rendimiento anterior
-- 3. No hay pérdida de datos ni riesgo de corrupción
-- 4. Se puede volver a ejecutar la migración en cualquier momento
-- 5. El rollback puede tomar 2-5 minutos dependiendo del tamaño de las tablas
