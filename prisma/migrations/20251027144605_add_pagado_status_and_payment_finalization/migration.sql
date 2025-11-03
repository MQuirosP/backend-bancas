-- AlterEnum: Add PAGADO to TicketStatus
ALTER TYPE "TicketStatus" ADD VALUE 'PAGADO';

-- AlterTable TicketPayment: Add new fields for payment finalization
ALTER TABLE "TicketPayment" ADD COLUMN "isFinal" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "completedAt" TIMESTAMP(3);

-- Create index on completedAt for dashboard queries
CREATE INDEX "idx_ticket_payment_completed_at" ON "TicketPayment"("completedAt");

-- Create index on isFinal for filtering partial payments
CREATE INDEX "idx_ticket_payment_is_final" ON "TicketPayment"("isFinal");

-- Create composite index for payment status queries
CREATE INDEX "idx_ticket_payment_final_reversed" ON "TicketPayment"("isFinal", "isReversed");
