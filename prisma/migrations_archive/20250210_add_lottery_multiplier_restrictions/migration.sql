-- Add columns for lottery/multiplier restriction rules
ALTER TABLE "RestrictionRule"
    ADD COLUMN "loteriaId" UUID,
    ADD COLUMN "multiplierId" UUID,
    ADD COLUMN "message" VARCHAR(255);

-- Add foreign keys
ALTER TABLE "RestrictionRule"
    ADD CONSTRAINT "RestrictionRule_loteriaId_fkey"
        FOREIGN KEY ("loteriaId") REFERENCES "Loteria"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RestrictionRule"
    ADD CONSTRAINT "RestrictionRule_multiplierId_fkey"
        FOREIGN KEY ("multiplierId") REFERENCES "LoteriaMultiplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes to speed up lookups by lottery/multiplier
CREATE INDEX "RestrictionRule_loteriaId_idx" ON "RestrictionRule" ("loteriaId");
CREATE INDEX "RestrictionRule_multiplierId_idx" ON "RestrictionRule" ("multiplierId");

