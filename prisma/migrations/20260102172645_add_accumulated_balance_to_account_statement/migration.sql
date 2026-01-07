--  MIGRACIÓN SEGURA: Agregar accumulatedBalance a AccountStatement
-- Esta migración es completamente segura porque:
-- 1. Solo agrega un campo nuevo con default 0 (no afecta datos existentes)
-- 2. Agrega índices para optimizar queries (no afecta datos)
-- 3. No modifica constraints existentes
-- 4. Es reversible (ver script de rollback)

-- AlterTable: Agregar campo accumulatedBalance
--  SEGURO: Campo nuevo con default 0, no afecta datos existentes
ALTER TABLE "AccountStatement" 
ADD COLUMN "accumulatedBalance" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateIndex: Índice compuesto para queries eficientes de accumulatedBalance
--  SEGURO: Solo crea índice, no afecta datos
CREATE INDEX "AccountStatement_month_isSettled_date_idx" 
ON "AccountStatement"("month", "isSettled", "date");

-- CreateIndex: Índice único parcial para bancaId (cuando ventanaId y vendedorId son null)
--  SEGURO: Previene duplicados cuando se consulta por banca sin ventana/vendedor
--  IMPORTANTE: Este índice es parcial (solo aplica cuando ventanaId y vendedorId son null)
-- Esto permite que existan statements con bancaId cuando también hay ventanaId o vendedorId
CREATE UNIQUE INDEX "account_statements_date_banca_unique" 
ON "AccountStatement"("date", "bancaId") 
WHERE "ventanaId" IS NULL AND "vendedorId" IS NULL;

--  NOTA: Después de aplicar esta migración, ejecutar el script de migración de datos
-- para calcular accumulatedBalance para todos los statements existentes.
-- Ver: scripts/migrate-accumulated-balance.ts
