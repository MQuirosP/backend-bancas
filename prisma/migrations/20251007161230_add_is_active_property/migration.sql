/*
  Warnings:

  - A unique constraint covering the columns `[name]` on the table `Sorteo` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `name` to the `Sorteo` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Banca" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Loteria" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Sorteo" ADD COLUMN     "name" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Ventana" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE UNIQUE INDEX "Sorteo_name_key" ON "Sorteo"("name");
