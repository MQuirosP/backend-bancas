-- AlterTable
-- Agregar campo totalCollected a AccountStatement para almacenar el total de collections (cobros) del día
ALTER TABLE "AccountStatement" ADD COLUMN "totalCollected" DOUBLE PRECISION NOT NULL DEFAULT 0;

