-- CreateEnum
CREATE TYPE "SorteoStatus" AS ENUM ('SCHEDULED', 'OPEN', 'EVALUATED', 'CLOSED');

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "sorteoId" TEXT;

-- AlterTable
ALTER TABLE "TicketCounter" ALTER COLUMN "currentNumber" SET DEFAULT 0;

-- CreateTable
CREATE TABLE "Sorteo" (
    "id" TEXT NOT NULL,
    "loteriaId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" "SorteoStatus" NOT NULL DEFAULT 'SCHEDULED',
    "winningNumber" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sorteo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Sorteo_loteriaId_scheduledAt_idx" ON "Sorteo"("loteriaId", "scheduledAt");

-- CreateIndex
CREATE INDEX "Ticket_sorteoId_idx" ON "Ticket"("sorteoId");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_sorteoId_fkey" FOREIGN KEY ("sorteoId") REFERENCES "Sorteo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sorteo" ADD CONSTRAINT "Sorteo_loteriaId_fkey" FOREIGN KEY ("loteriaId") REFERENCES "Loteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
