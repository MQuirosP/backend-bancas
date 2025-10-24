/*
  Warnings:

  - You are about to drop the column `isDeleted` on the `Jugada` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Jugada" DROP COLUMN "isDeleted",
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;
