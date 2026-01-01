-- CreateTable
-- ✅ SEGURO: Nueva tabla MonthlyClosingBalance (no afecta datos existentes)
-- Esta tabla almacena los saldos de cierre mensual calculados con TODOS los datos del mes
CREATE TABLE "MonthlyClosingBalance" (
    "id" UUID NOT NULL,
    "closingMonth" VARCHAR(7) NOT NULL,
    "dimension" VARCHAR(20) NOT NULL,
    "vendedorId" UUID,
    "ventanaId" UUID,
    "bancaId" UUID,
    "closingBalance" DECIMAL(15, 2) NOT NULL,
    "totalSales" DECIMAL(15, 2) NOT NULL,
    "totalPayouts" DECIMAL(15, 2) NOT NULL,
    "totalCommission" DECIMAL(15, 2) NOT NULL,
    "totalPaid" DECIMAL(15, 2) NOT NULL,
    "totalCollected" DECIMAL(15, 2) NOT NULL,
    "ticketCount" INTEGER NOT NULL,
    "closingDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonthlyClosingBalance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- ✅ SEGURO: Índices para optimizar queries (no afecta datos)
CREATE UNIQUE INDEX "MonthlyClosingBalance_closingMonth_dimension_vendedorId_ventanaId_bancaId_key" ON "MonthlyClosingBalance"("closingMonth", "dimension", "vendedorId", "ventanaId", "bancaId");
CREATE INDEX "MonthlyClosingBalance_closingMonth_idx" ON "MonthlyClosingBalance"("closingMonth");
CREATE INDEX "MonthlyClosingBalance_dimension_vendedorId_ventanaId_bancaId_idx" ON "MonthlyClosingBalance"("dimension", "vendedorId", "ventanaId", "bancaId");
CREATE INDEX "MonthlyClosingBalance_closingDate_idx" ON "MonthlyClosingBalance"("closingDate");

-- AddForeignKey
-- ✅ SEGURO: Foreign keys opcionales (no afecta datos existentes)
ALTER TABLE "MonthlyClosingBalance" ADD CONSTRAINT "MonthlyClosingBalance_vendedorId_fkey" FOREIGN KEY ("vendedorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MonthlyClosingBalance" ADD CONSTRAINT "MonthlyClosingBalance_ventanaId_fkey" FOREIGN KEY ("ventanaId") REFERENCES "Ventana"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MonthlyClosingBalance" ADD CONSTRAINT "MonthlyClosingBalance_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;
