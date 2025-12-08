-- AlterTable
-- ✅ SEGURO: Agregar campos nullable a AccountStatement (no afecta datos existentes)
ALTER TABLE "AccountStatement" ADD COLUMN "settledAt" TIMESTAMP(3);
ALTER TABLE "AccountStatement" ADD COLUMN "settledBy" UUID;

-- CreateTable
-- ✅ SEGURO: Nueva tabla AccountStatementSettlementConfig (no afecta datos existentes)
CREATE TABLE "AccountStatementSettlementConfig" (
    "id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "settlementAgeDays" INTEGER NOT NULL DEFAULT 7,
    "cronSchedule" VARCHAR(50),
    "batchSize" INTEGER NOT NULL DEFAULT 1000,
    "lastExecution" TIMESTAMP(3),
    "lastSettledCount" INTEGER,
    "lastSkippedCount" INTEGER,
    "lastErrorCount" INTEGER,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" UUID,

    CONSTRAINT "AccountStatementSettlementConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- ✅ SEGURO: Índices para optimizar queries (no afecta datos)
CREATE INDEX "AccountStatement_isSettled_date_idx" ON "AccountStatement"("isSettled", "date");
CREATE INDEX "AccountStatementSettlementConfig_enabled_idx" ON "AccountStatementSettlementConfig"("enabled");

-- AddForeignKey
-- ✅ SEGURO: Foreign keys (no modifica datos existentes)
ALTER TABLE "AccountStatement" ADD CONSTRAINT "AccountStatement_settledBy_fkey" FOREIGN KEY ("settledBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountStatementSettlementConfig" ADD CONSTRAINT "AccountStatementSettlementConfig_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

