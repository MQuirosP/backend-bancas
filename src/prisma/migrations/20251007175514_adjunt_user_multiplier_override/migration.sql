/*
  Warnings:

  - A unique constraint covering the columns `[userId,loteriaId,multiplierType]` on the table `UserMultiplierOverride` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `multiplierType` to the `UserMultiplierOverride` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "UserMultiplierOverride" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedBy" TEXT,
ADD COLUMN     "deletedReason" TEXT,
ADD COLUMN     "isDeleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "multiplierType" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "UserMultiplierOverride_userId_loteriaId_multiplierType_key" ON "UserMultiplierOverride"("userId", "loteriaId", "multiplierType");
