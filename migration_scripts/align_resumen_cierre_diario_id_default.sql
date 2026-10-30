-- Migration: Align ResumenCierreDiario id with DEFAULT gen_random_uuid()
-- Reason: Adhere to Rule 16 of AGENTS.md (Avoid crypto UUID generation in SELECT projections of bulk rollups)
-- Status: Executed via Supabase SQL Editor on 2026-10-29

ALTER TABLE public."ResumenCierreDiario" 
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
