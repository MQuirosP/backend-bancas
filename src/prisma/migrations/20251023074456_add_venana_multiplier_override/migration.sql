-- CreateTable
CREATE TABLE "VentanaMultiplierOverride" (
    "id" TEXT NOT NULL,
    "ventanaId" TEXT NOT NULL,
    "loteriaId" TEXT NOT NULL,
    "baseMultiplierX" DOUBLE PRECISION NOT NULL,
    "multiplierType" TEXT NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VentanaMultiplierOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VentanaMultiplierOverride_ventanaId_loteriaId_multiplierTyp_key" ON "VentanaMultiplierOverride"("ventanaId", "loteriaId", "multiplierType");

-- AddForeignKey
ALTER TABLE "VentanaMultiplierOverride" ADD CONSTRAINT "VentanaMultiplierOverride_ventanaId_fkey" FOREIGN KEY ("ventanaId") REFERENCES "Ventana"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VentanaMultiplierOverride" ADD CONSTRAINT "VentanaMultiplierOverride_loteriaId_fkey" FOREIGN KEY ("loteriaId") REFERENCES "Loteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
