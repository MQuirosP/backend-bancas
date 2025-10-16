-- AlterEnum
ALTER TYPE "ActivityType" ADD VALUE 'SORTEO_OPEN';

-- RenameIndex
ALTER INDEX "ticket_ticketnumber_key" RENAME TO "Ticket_ticketNumber_key";
