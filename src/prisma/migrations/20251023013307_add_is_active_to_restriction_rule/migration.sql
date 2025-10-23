/*
  Warnings:

  - You are about to drop the column `isDeleted` on the `RestrictionRule` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "RestrictionRule" DROP COLUMN "isDeleted",
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;
