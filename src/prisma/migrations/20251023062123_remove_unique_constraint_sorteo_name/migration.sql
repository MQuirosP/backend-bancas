/*
  Warnings:

  - A unique constraint covering the columns `[name]` on the table `Loteria` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "public"."Sorteo_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "Loteria_name_key" ON "Loteria"("name");
