-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- AlterTable: Agregar campos de pago unificados a Ticket
ALTER TABLE "Ticket" 
ADD COLUMN IF NOT EXISTS "totalPayout" DOUBLE PRECISION DEFAULT 0,
ADD COLUMN IF NOT EXISTS "totalPaid" DOUBLE PRECISION DEFAULT 0,
ADD COLUMN IF NOT EXISTS "remainingAmount" DOUBLE PRECISION DEFAULT 0,
ADD COLUMN IF NOT EXISTS "lastPaymentAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "paidById" UUID,
ADD COLUMN IF NOT EXISTS "paymentMethod" TEXT,
ADD COLUMN IF NOT EXISTS "paymentNotes" TEXT,
ADD COLUMN IF NOT EXISTS "paymentHistory" JSONB;

-- CreateIndex: Índices para optimizar queries
CREATE INDEX IF NOT EXISTS "Ticket_status_isWinner_idx" ON "Ticket"("status", "isWinner");
CREATE INDEX IF NOT EXISTS "Ticket_paidById_idx" ON "Ticket"("paidById");

-- AddForeignKey: Relación con User (paidBy)
ALTER TABLE "Ticket" 
ADD CONSTRAINT "Ticket_paidById_fkey" 
FOREIGN KEY ("paidById") 
REFERENCES "User"("id") 
ON DELETE SET NULL 
ON UPDATE CASCADE;

-- Comentarios para documentación
COMMENT ON COLUMN "Ticket"."totalPayout" IS 'Total de premios ganados (suma de jugadas ganadoras)';
COMMENT ON COLUMN "Ticket"."totalPaid" IS 'Total pagado acumulado hasta el momento';
COMMENT ON COLUMN "Ticket"."remainingAmount" IS 'Monto pendiente de pago (totalPayout - totalPaid)';
COMMENT ON COLUMN "Ticket"."lastPaymentAt" IS 'Fecha y hora del último pago registrado';
COMMENT ON COLUMN "Ticket"."paidById" IS 'ID del usuario que realizó el último pago';
COMMENT ON COLUMN "Ticket"."paymentMethod" IS 'Método de pago del último registro (cash, transfer, check, other)';
COMMENT ON COLUMN "Ticket"."paymentNotes" IS 'Notas del último pago';
COMMENT ON COLUMN "Ticket"."paymentHistory" IS 'Historial completo de pagos en formato JSON';




