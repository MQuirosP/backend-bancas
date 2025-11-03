-- Add settings column to User table
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "settings" JSONB;

-- Add settings column to Ventana table
ALTER TABLE "Ventana" ADD COLUMN IF NOT EXISTS "settings" JSONB;
