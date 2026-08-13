-- AlterTable
ALTER TABLE "Sorteo" ADD COLUMN "deletedByCascade" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Sorteo" ADD COLUMN "deletedByCascadeFrom" VARCHAR(255);
ALTER TABLE "Sorteo" ADD COLUMN "deletedByCascadeId" UUID;

-- CreateIndex
CREATE INDEX "idx_sorteos_loteria_id_deleted_at" ON "Sorteo"("loteriaId", "deletedAt");
CREATE INDEX "idx_sorteos_cascade_fields" ON "Sorteo"("deletedByCascade", "deletedByCascadeFrom", "deletedByCascadeId");

-- Update existing inactive sorteos to have deletedByCascade = false (manual deletions)
UPDATE "Sorteo" SET "deletedByCascade" = false WHERE "deletedAt" IS NOT NULL;

