/*
  Warnings:

  - Made the column `globalMaxPerNumber` on table `Banca` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "Banca" ALTER COLUMN "globalMaxPerNumber" SET NOT NULL,
ALTER COLUMN "globalMaxPerNumber" SET DEFAULT 5000;
