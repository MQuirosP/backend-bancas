-- Safe additive migration: businessDate on Ticket and TicketCounter table
-- This migration is idempotent (IF NOT EXISTS) to be safe in deploys.

-- 1) Add businessDate DATE column to Ticket
ALTER TABLE "Ticket"
  ADD COLUMN IF NOT EXISTS "businessDate" date NULL;

-- 2) Create TicketCounter table for per-day per-ventana ticket sequence
CREATE TABLE IF NOT EXISTS "TicketCounter" (
  "businessDate" date NOT NULL,
  "ventanaId" uuid NOT NULL,
  "last" integer NOT NULL DEFAULT 0,
  CONSTRAINT "TicketCounter_pkey" PRIMARY KEY ("businessDate", "ventanaId")
);

-- 3) Unique index to support diagnostic tolerance (optional but helpful)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = ANY (current_schemas(false))
      AND indexname = 'TicketCounter_businessDate_ventanaId_last_key'
  ) THEN
    CREATE UNIQUE INDEX "TicketCounter_businessDate_ventanaId_last_key"
      ON "TicketCounter" ("businessDate", "ventanaId", "last");
  END IF;
END $$;

