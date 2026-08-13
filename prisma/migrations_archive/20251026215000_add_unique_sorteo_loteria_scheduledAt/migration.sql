-- Add unique constraint/index to prevent duplicate draws per loteria and datetime
CREATE UNIQUE INDEX IF NOT EXISTS "Sorteo_loteriaId_scheduledAt_key"
  ON "Sorteo" ("loteriaId", "scheduledAt");

