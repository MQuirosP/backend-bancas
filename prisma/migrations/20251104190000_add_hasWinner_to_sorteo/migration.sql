-- AlterTable: Add hasWinner column to Sorteo
-- This column indicates if the sorteo has any winning tickets
-- Default value: false (never null)

ALTER TABLE "Sorteo" ADD COLUMN "hasWinner" BOOLEAN NOT NULL DEFAULT false;

