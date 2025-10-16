-- CreateEnum
CREATE TYPE "BetType" AS ENUM ('NUMERO', 'REVENTADO');

-- CreateEnum
CREATE TYPE "MultiplierKind" AS ENUM ('NUMERO', 'REVENTADO');

-- AlterTable
ALTER TABLE "Jugada" ADD COLUMN     "reventadoNumber" TEXT,
ADD COLUMN     "settledMultiplierId" TEXT,
ADD COLUMN     "settledMultiplierX" DOUBLE PRECISION,
ADD COLUMN     "type" "BetType" NOT NULL DEFAULT 'NUMERO';

-- AlterTable
ALTER TABLE "LoteriaMultiplier" ADD COLUMN     "kind" "MultiplierKind" NOT NULL DEFAULT 'NUMERO';

-- AlterTable
ALTER TABLE "Sorteo" ADD COLUMN     "extraMultiplierId" TEXT,
ADD COLUMN     "extraMultiplierX" DOUBLE PRECISION,
ADD COLUMN     "extraOutcomeCode" TEXT;

-- CreateIndex
CREATE INDEX "Jugada_ticketId_idx" ON "Jugada"("ticketId");

-- CreateIndex
CREATE INDEX "Jugada_type_idx" ON "Jugada"("type");

-- CreateIndex
CREATE INDEX "Jugada_reventadoNumber_idx" ON "Jugada"("reventadoNumber");

-- CreateIndex
CREATE INDEX "Jugada_settledMultiplierId_idx" ON "Jugada"("settledMultiplierId");

-- CreateIndex
CREATE INDEX "LoteriaMultiplier_loteriaId_kind_isActive_idx" ON "LoteriaMultiplier"("loteriaId", "kind", "isActive");

-- CreateIndex
CREATE INDEX "LoteriaMultiplier_appliesToSorteoId_idx" ON "LoteriaMultiplier"("appliesToSorteoId");

-- CreateIndex
CREATE INDEX "Sorteo_extraMultiplierId_idx" ON "Sorteo"("extraMultiplierId");

-- AddForeignKey
ALTER TABLE "Jugada" ADD CONSTRAINT "Jugada_settledMultiplierId_fkey" FOREIGN KEY ("settledMultiplierId") REFERENCES "LoteriaMultiplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sorteo" ADD CONSTRAINT "Sorteo_extraMultiplierId_fkey" FOREIGN KEY ("extraMultiplierId") REFERENCES "LoteriaMultiplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
