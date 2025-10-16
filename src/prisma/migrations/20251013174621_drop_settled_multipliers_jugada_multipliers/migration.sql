/*
  Warnings:

  - You are about to drop the column `settledMultiplierId` on the `Jugada` table. All the data in the column will be lost.
  - You are about to drop the column `settledMultiplierX` on the `Jugada` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."Jugada" DROP CONSTRAINT "Jugada_multiplierId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Jugada" DROP CONSTRAINT "Jugada_settledMultiplierId_fkey";

-- DropIndex
DROP INDEX "public"."Jugada_settledMultiplierId_idx";

-- AlterTable
ALTER TABLE "Jugada" DROP COLUMN "settledMultiplierId",
DROP COLUMN "settledMultiplierX",
ALTER COLUMN "multiplierId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Jugada" ADD CONSTRAINT "Jugada_multiplierId_fkey" FOREIGN KEY ("multiplierId") REFERENCES "LoteriaMultiplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
