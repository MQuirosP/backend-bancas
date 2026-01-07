--  ROLLBACK SEGURO: Revertir migración de accumulatedBalance
-- Este script revierte los cambios de forma segura:
-- 1. Elimina índices (no afecta datos)
-- 2. Elimina campo accumulatedBalance (️ PERDERÁ los datos de accumulatedBalance)
-- 
-- ️ ADVERTENCIA: Este rollback eliminará todos los valores de accumulatedBalance
-- Si necesitas conservar estos datos, exportarlos antes de ejecutar este rollback

-- DropIndex: Eliminar índice único parcial para bancaId
DROP INDEX IF EXISTS "account_statements_date_banca_unique";

-- DropIndex: Eliminar índice compuesto
DROP INDEX IF EXISTS "AccountStatement_month_isSettled_date_idx";

-- AlterTable: Eliminar campo accumulatedBalance
-- ️ ADVERTENCIA: Esto eliminará todos los valores de accumulatedBalance
ALTER TABLE "AccountStatement" 
DROP COLUMN IF EXISTS "accumulatedBalance";
