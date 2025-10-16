/*
  Warnings:

  - Made the column `sorteoId` on table `Ticket` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "public"."Ticket" DROP CONSTRAINT "Ticket_sorteoId_fkey";

-- AlterTable
ALTER TABLE "Ticket" ALTER COLUMN "sorteoId" SET NOT NULL;

-- AlterTable
ALTER TABLE "TicketCounter" ALTER COLUMN "id" SET DEFAULT 'DEFAULT';

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_sorteoId_fkey" FOREIGN KEY ("sorteoId") REFERENCES "Sorteo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
