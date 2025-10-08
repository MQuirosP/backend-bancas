/*
  Warnings:

  - A unique constraint covering the columns `[idempotencyKey]` on the table `TicketPayment` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityType" ADD VALUE 'TICKET_PAY';
ALTER TYPE "ActivityType" ADD VALUE 'TICKET_PAYMENT_REVERSE';

-- AlterTable
ALTER TABLE "TicketPayment" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "isPartial" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "remainingAmount" DOUBLE PRECISION;

-- CreateIndex
CREATE UNIQUE INDEX "TicketPayment_idempotencyKey_key" ON "TicketPayment"("idempotencyKey");
