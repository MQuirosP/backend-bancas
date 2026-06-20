-- =============================================================================
-- FASE 3: OPERACIÓN MULTI-TENANT & DBA OPTIMIZATION
-- SCRIPT DE SANEAMIENTO Y PODA ESTRUCTURAL (SUPABASE / POSTGRESQL)
-- =============================================================================

-- =============================================================================
-- TAREA B: Script SQL de Poda Estructural y Saneamiento Multi-Tenant
-- =============================================================================

BEGIN;

-- 1. Eliminar de forma segura las vistas materializadas muertas y sus funciones
DROP MATERIALIZED VIEW IF EXISTS mv_daily_account_summary CASCADE;
DROP MATERIALIZED VIEW IF EXISTS mv_diario_ventas_totales CASCADE;
DROP FUNCTION IF EXISTS refresh_daily_account_summary() CASCADE;
DROP FUNCTION IF EXISTS refresh_diario_ventas_totales() CASCADE;

-- 2. Eliminar los índices en desuso reportados por el linter
-- Esto libera memoria en las Buffer Pools de RAM de PostgreSQL.
DROP INDEX IF EXISTS "idx_ticket_createdBy_fk";
DROP INDEX IF EXISTS "ApiKey_key_isActive_idx";
DROP INDEX IF EXISTS "LoteriaMultiplier_appliesToSorteoId_idx";
DROP INDEX IF EXISTS "idx_override_lookup";
DROP INDEX IF EXISTS "idx_AccountPayment_paidById";
DROP INDEX IF EXISTS "idx_AccountPayment_reversedBy";
DROP INDEX IF EXISTS "idx_MonthlyClosingBalance_ventanaId";
DROP INDEX IF EXISTS "MonthlyClosingBalance_dimension_vendedorId_ventanaId_bancaId_id";
DROP INDEX IF EXISTS "AccountStatementSettlementConfig_bancaId_idx";
DROP INDEX IF EXISTS "sorteo_lista_exclusion_banca_id_idx";

-- 3. Crear índices B-Tree de cobertura para llaves foráneas multi-tenant desprotegidas
-- Optimiza las operaciones en cascada y evita bloqueos de tablas en actualizaciones concurrentes.
CREATE INDEX IF NOT EXISTS "idx_AccountStatement_settledBy" ON "AccountStatement"("settledBy");
CREATE INDEX IF NOT EXISTS "idx_ApiKey_bancaId" ON "ApiKey"("bancaId");
CREATE INDEX IF NOT EXISTS "idx_LoteriaMultiplier_bancaId" ON "LoteriaMultiplier"("bancaId");
CREATE INDEX IF NOT EXISTS "idx_Jugada_excludedBy" ON "Jugada"("excludedBy");
CREATE INDEX IF NOT EXISTS "idx_Ventana_bancaId" ON "Ventana"("bancaId");
CREATE INDEX IF NOT EXISTS "idx_sorteo_lista_exclusion_excluded_by" ON "sorteo_lista_exclusion"("excluded_by");

COMMIT;
