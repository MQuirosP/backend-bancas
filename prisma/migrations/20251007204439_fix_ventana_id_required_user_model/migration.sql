/*
  Warnings:

  - Made the column `ventanaId` on table `User` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "public"."User" DROP CONSTRAINT "User_ventanaId_fkey";

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "ventanaId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_ventanaId_fkey" FOREIGN KEY ("ventanaId") REFERENCES "Ventana"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
