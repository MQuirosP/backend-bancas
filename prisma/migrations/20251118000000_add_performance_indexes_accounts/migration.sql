--  OPTIMIZACIÓN: Agregar índices críticos para mejorar performance de queries de accounts

-- Índice en businessDate para filtros por fecha (muy usado en accounts)
CREATE INDEX IF NOT EXISTS "idx_ticket_business_date" ON "Ticket"("businessDate") WHERE "deletedAt" IS NULL AND "status" != 'CANCELLED';

-- Índice compuesto para queries frecuentes de tickets por fecha, ventana y vendedor
CREATE INDEX IF NOT EXISTS "idx_ticket_business_date_ventana_vendedor" 
ON "Ticket"("businessDate", "ventanaId", "vendedorId") 
WHERE "deletedAt" IS NULL AND "status" != 'CANCELLED';

-- Índice compuesto para jugadas (comisiones) - usado en computeListeroCommissionsForWhere
CREATE INDEX IF NOT EXISTS "idx_jugada_ticket_deleted_commission" 
ON "Jugada"("ticketId", "deletedAt", "commissionOrigin") 
WHERE "deletedAt" IS NULL;

-- Índice compuesto para AccountPayment (ya optimizado con batch, pero ayuda con queries individuales)
CREATE INDEX IF NOT EXISTS "idx_account_payment_statement_reversed_type" 
ON "AccountPayment"("accountStatementId", "isReversed", "type") 
WHERE "isReversed" = false;

-- Índice en createdAt de AccountPayment para verificar cambios recientes
CREATE INDEX IF NOT EXISTS "idx_account_payment_created_at" 
ON "AccountPayment"("createdAt");

-- Índice en createdAt de Ticket para verificar cambios recientes (fallback cuando businessDate es null)
CREATE INDEX IF NOT EXISTS "idx_ticket_created_at" 
ON "Ticket"("createdAt") 
WHERE "deletedAt" IS NULL AND "status" != 'CANCELLED';

