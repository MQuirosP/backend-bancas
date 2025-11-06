-- Script SIMPLE para agregar ActivityType values en Supabase
-- Si el script con DO $$ falla, usa este (cada comando individual)
-- Copiar y pegar en SQL Editor de Supabase Dashboard

-- Ejecutar cada comando por separado si alguno da error

ALTER TYPE "ActivityType" ADD VALUE 'ACCOUNT_STATEMENT_VIEW';
ALTER TYPE "ActivityType" ADD VALUE 'ACCOUNT_PAYMENT_CREATE';
ALTER TYPE "ActivityType" ADD VALUE 'ACCOUNT_PAYMENT_REVERSE';
ALTER TYPE "ActivityType" ADD VALUE 'ACCOUNT_PAYMENT_HISTORY_VIEW';

-- Si alguno da error "already exists", simplemente ignóralo y continúa con el siguiente

