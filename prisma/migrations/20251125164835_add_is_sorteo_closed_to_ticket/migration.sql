-- AlterTable: Agregar campo isSorteoClosed a Ticket para rastrear cierre cascada de sorteos
ALTER TABLE "Ticket" ADD COLUMN "isSorteoClosed" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex: Índice para filtrado rápido de tickets de sorteos cerrados
CREATE INDEX "idx_ticket_is_sorteo_closed" ON "Ticket"("isSorteoClosed");
