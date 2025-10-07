-- DropForeignKey
ALTER TABLE "public"."User" DROP CONSTRAINT "User_ventanaId_fkey";

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "ventanaId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_ventanaId_fkey" FOREIGN KEY ("ventanaId") REFERENCES "Ventana"("id") ON DELETE SET NULL ON UPDATE CASCADE;
