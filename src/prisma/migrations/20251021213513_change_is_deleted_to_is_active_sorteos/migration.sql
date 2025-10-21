/*
  Warnings:

  - You are about to drop the column `isDeleted` on the `Sorteo` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Sorteo" DROP COLUMN "isDeleted",
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;
