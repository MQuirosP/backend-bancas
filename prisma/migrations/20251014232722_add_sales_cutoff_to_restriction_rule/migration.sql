/*
  Warnings:

  - You are about to drop the column `salesCutOffMinutes` on the `Banca` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Banca" DROP COLUMN "salesCutOffMinutes";

-- AlterTable
ALTER TABLE "RestrictionRule" ADD COLUMN     "salesCutoffMinutes" INTEGER;
