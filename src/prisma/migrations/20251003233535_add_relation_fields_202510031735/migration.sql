/*
  Warnings:

  - Added the required column `multiplierId` to the `Jugada` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Jugada" ADD COLUMN     "multiplierId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "RestrictionRule" (
    "id" TEXT NOT NULL,
    "bancaId" TEXT,
    "ventanaId" TEXT,
    "userId" TEXT,
    "number" TEXT,
    "maxAmount" DOUBLE PRECISION,
    "maxTotal" DOUBLE PRECISION,
    "appliesToDate" TIMESTAMP(3),
    "appliesToHour" INTEGER,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestrictionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoteriaMultiplier" (
    "id" TEXT NOT NULL,
    "loteriaId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "valueX" DOUBLE PRECISION NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "appliesToDate" TIMESTAMP(3),
    "appliesToSorteoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoteriaMultiplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserMultiplierOverride" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "loteriaId" TEXT NOT NULL,
    "baseMultiplierX" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserMultiplierOverride_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Jugada" ADD CONSTRAINT "Jugada_multiplierId_fkey" FOREIGN KEY ("multiplierId") REFERENCES "LoteriaMultiplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestrictionRule" ADD CONSTRAINT "RestrictionRule_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestrictionRule" ADD CONSTRAINT "RestrictionRule_ventanaId_fkey" FOREIGN KEY ("ventanaId") REFERENCES "Ventana"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestrictionRule" ADD CONSTRAINT "RestrictionRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoteriaMultiplier" ADD CONSTRAINT "LoteriaMultiplier_loteriaId_fkey" FOREIGN KEY ("loteriaId") REFERENCES "Loteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMultiplierOverride" ADD CONSTRAINT "UserMultiplierOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMultiplierOverride" ADD CONSTRAINT "UserMultiplierOverride_loteriaId_fkey" FOREIGN KEY ("loteriaId") REFERENCES "Loteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
