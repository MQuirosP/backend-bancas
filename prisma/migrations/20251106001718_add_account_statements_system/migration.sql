-- CreateTable: AccountStatement
-- Estado de cuenta por día (Banca  Listero  Vendedor)
-- Safe migration: verifica que la tabla no exista antes de crearla

CREATE TABLE IF NOT EXISTS "AccountStatement" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "date" DATE NOT NULL,
  "month" VARCHAR(7) NOT NULL,
  "ventanaId" UUID,
  "vendedorId" UUID,
  
  -- Totales del día
  "totalSales" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "totalPayouts" DOUBLE PRECISION NOT NULL DEFAULT 0,
  
  -- Comisiones (informativas)
  "listeroCommission" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "vendedorCommission" DOUBLE PRECISION NOT NULL DEFAULT 0,
  
  -- Saldo y pagos
  "balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "totalPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "remainingBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
  
  -- Estado
  "isSettled" BOOLEAN NOT NULL DEFAULT false,
  "canEdit" BOOLEAN NOT NULL DEFAULT true,
  
  -- Metadatos
  "ticketCount" INTEGER NOT NULL DEFAULT 0,
  
  -- Timestamps
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT "AccountStatement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountStatement_one_relation_check" CHECK (
    ("ventanaId" IS NOT NULL AND "vendedorId" IS NULL) OR
    ("ventanaId" IS NULL AND "vendedorId" IS NOT NULL)
  )
);

-- CreateTable: AccountPayment
-- Historial de pagos/cobros
-- Safe migration: verifica que la tabla no exista antes de crearla

CREATE TABLE IF NOT EXISTS "AccountPayment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  
  -- Relación con estado de cuenta
  "accountStatementId" UUID NOT NULL,
  
  -- Identificación del día
  "date" DATE NOT NULL,
  "month" VARCHAR(7) NOT NULL,
  
  -- Relaciones
  "ventanaId" UUID,
  "vendedorId" UUID,
  
  -- Detalles del pago/cobro
  "amount" DOUBLE PRECISION NOT NULL,
  "type" VARCHAR(20) NOT NULL,
  "method" VARCHAR(20) NOT NULL,
  "notes" TEXT,
  
  -- Estado
  "isFinal" BOOLEAN NOT NULL DEFAULT false,
  "isReversed" BOOLEAN NOT NULL DEFAULT false,
  "reversedAt" TIMESTAMP(3),
  "reversedBy" UUID,
  
  -- Auditoría
  "paidById" UUID NOT NULL,
  "paidByName" VARCHAR(255) NOT NULL,
  
  -- Idempotencia
  "idempotencyKey" VARCHAR(255),
  
  -- Timestamps
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT "AccountPayment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountPayment_amount_positive_check" CHECK ("amount" > 0),
  CONSTRAINT "AccountPayment_type_valid_check" CHECK ("type" IN ('payment', 'collection')),
  CONSTRAINT "AccountPayment_method_valid_check" CHECK ("method" IN ('cash', 'transfer', 'check', 'other')),
  CONSTRAINT "AccountPayment_one_relation_check" CHECK (
    ("ventanaId" IS NOT NULL AND "vendedorId" IS NULL) OR
    ("ventanaId" IS NULL AND "vendedorId" IS NOT NULL)
  )
);

-- CreateUniqueConstraint: AccountStatement date + ventanaId unique
CREATE UNIQUE INDEX IF NOT EXISTS "account_statements_date_ventana_unique" 
ON "AccountStatement"("date", "ventanaId") 
WHERE "ventanaId" IS NOT NULL;

-- CreateUniqueConstraint: AccountStatement date + vendedorId unique
CREATE UNIQUE INDEX IF NOT EXISTS "account_statements_date_vendedor_unique" 
ON "AccountStatement"("date", "vendedorId") 
WHERE "vendedorId" IS NOT NULL;

-- CreateUniqueConstraint: AccountPayment idempotencyKey unique
CREATE UNIQUE INDEX IF NOT EXISTS "AccountPayment_idempotencyKey_key" 
ON "AccountPayment"("idempotencyKey") 
WHERE "idempotencyKey" IS NOT NULL;

-- CreateIndex: AccountStatement month index
CREATE INDEX IF NOT EXISTS "AccountStatement_month_idx" ON "AccountStatement"("month");

-- CreateIndex: AccountStatement date index
CREATE INDEX IF NOT EXISTS "AccountStatement_date_idx" ON "AccountStatement"("date");

-- CreateIndex: AccountStatement ventanaId index
CREATE INDEX IF NOT EXISTS "AccountStatement_ventanaId_idx" ON "AccountStatement"("ventanaId") 
WHERE "ventanaId" IS NOT NULL;

-- CreateIndex: AccountStatement vendedorId index
CREATE INDEX IF NOT EXISTS "AccountStatement_vendedorId_idx" ON "AccountStatement"("vendedorId") 
WHERE "vendedorId" IS NOT NULL;

-- CreateIndex: AccountStatement isSettled index
CREATE INDEX IF NOT EXISTS "AccountStatement_isSettled_idx" ON "AccountStatement"("isSettled");

-- CreateIndex: AccountPayment accountStatementId index
CREATE INDEX IF NOT EXISTS "AccountPayment_accountStatementId_idx" ON "AccountPayment"("accountStatementId");

-- CreateIndex: AccountPayment date index
CREATE INDEX IF NOT EXISTS "AccountPayment_date_idx" ON "AccountPayment"("date");

-- CreateIndex: AccountPayment month index
CREATE INDEX IF NOT EXISTS "AccountPayment_month_idx" ON "AccountPayment"("month");

-- CreateIndex: AccountPayment ventanaId index
CREATE INDEX IF NOT EXISTS "AccountPayment_ventanaId_idx" ON "AccountPayment"("ventanaId") 
WHERE "ventanaId" IS NOT NULL;

-- CreateIndex: AccountPayment vendedorId index
CREATE INDEX IF NOT EXISTS "AccountPayment_vendedorId_idx" ON "AccountPayment"("vendedorId") 
WHERE "vendedorId" IS NOT NULL;

-- CreateIndex: AccountPayment isReversed index
CREATE INDEX IF NOT EXISTS "AccountPayment_isReversed_idx" ON "AccountPayment"("isReversed");

-- AddForeignKey: AccountStatement ventanaId
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'AccountStatement_ventanaId_fkey'
  ) THEN
    ALTER TABLE "AccountStatement" 
    ADD CONSTRAINT "AccountStatement_ventanaId_fkey" 
    FOREIGN KEY ("ventanaId") 
    REFERENCES "Ventana"("id") 
    ON DELETE CASCADE 
    ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey: AccountStatement vendedorId
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'AccountStatement_vendedorId_fkey'
  ) THEN
    ALTER TABLE "AccountStatement" 
    ADD CONSTRAINT "AccountStatement_vendedorId_fkey" 
    FOREIGN KEY ("vendedorId") 
    REFERENCES "User"("id") 
    ON DELETE CASCADE 
    ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey: AccountPayment accountStatementId
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'AccountPayment_accountStatementId_fkey'
  ) THEN
    ALTER TABLE "AccountPayment" 
    ADD CONSTRAINT "AccountPayment_accountStatementId_fkey" 
    FOREIGN KEY ("accountStatementId") 
    REFERENCES "AccountStatement"("id") 
    ON DELETE CASCADE 
    ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey: AccountPayment ventanaId
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'AccountPayment_ventanaId_fkey'
  ) THEN
    ALTER TABLE "AccountPayment" 
    ADD CONSTRAINT "AccountPayment_ventanaId_fkey" 
    FOREIGN KEY ("ventanaId") 
    REFERENCES "Ventana"("id") 
    ON DELETE CASCADE 
    ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey: AccountPayment vendedorId
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'AccountPayment_vendedorId_fkey'
  ) THEN
    ALTER TABLE "AccountPayment" 
    ADD CONSTRAINT "AccountPayment_vendedorId_fkey" 
    FOREIGN KEY ("vendedorId") 
    REFERENCES "User"("id") 
    ON DELETE CASCADE 
    ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey: AccountPayment paidById
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'AccountPayment_paidById_fkey'
  ) THEN
    ALTER TABLE "AccountPayment" 
    ADD CONSTRAINT "AccountPayment_paidById_fkey" 
    FOREIGN KEY ("paidById") 
    REFERENCES "User"("id") 
    ON DELETE RESTRICT 
    ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey: AccountPayment reversedBy
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'AccountPayment_reversedBy_fkey'
  ) THEN
    ALTER TABLE "AccountPayment" 
    ADD CONSTRAINT "AccountPayment_reversedBy_fkey" 
    FOREIGN KEY ("reversedBy") 
    REFERENCES "User"("id") 
    ON DELETE SET NULL 
    ON UPDATE CASCADE;
  END IF;
END $$;

-- Add trigger to update updatedAt timestamp for AccountStatement
CREATE OR REPLACE FUNCTION update_account_statement_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger 
    WHERE tgname = 'AccountStatement_updatedAt'
  ) THEN
    CREATE TRIGGER "AccountStatement_updatedAt"
    BEFORE UPDATE ON "AccountStatement"
    FOR EACH ROW
    EXECUTE FUNCTION update_account_statement_updated_at();
  END IF;
END $$;

-- Add trigger to update updatedAt timestamp for AccountPayment
CREATE OR REPLACE FUNCTION update_account_payment_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger 
    WHERE tgname = 'AccountPayment_updatedAt'
  ) THEN
    CREATE TRIGGER "AccountPayment_updatedAt"
    BEFORE UPDATE ON "AccountPayment"
    FOR EACH ROW
    EXECUTE FUNCTION update_account_payment_updated_at();
  END IF;
END $$;

