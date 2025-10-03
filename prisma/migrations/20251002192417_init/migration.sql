-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'VENTANA', 'VENDEDOR');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('PENDING', 'WINNER', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('LOGIN', 'TICKET_CREATE', 'TICKET_CANCEL', 'SORTEO_CLOSURE', 'UPDATE_USER', 'UPDATE_MULTIPLIER_SETTING', 'SOFT_DELETE', 'RESTORE');

-- CreateTable
CREATE TABLE "Banca" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "defaultMinBet" DOUBLE PRECISION NOT NULL DEFAULT 1.00,
    "globalMaxPerNumber" INTEGER,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Banca_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ventana" (
    "id" TEXT NOT NULL,
    "bancaId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "commissionMarginX" DOUBLE PRECISION NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ventana_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "ventanaId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VENTANA',
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Loteria" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rulesJson" JSONB,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Loteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BancaLoteriaSetting" (
    "id" TEXT NOT NULL,
    "bancaId" TEXT NOT NULL,
    "loteriaId" TEXT NOT NULL,
    "baseMultiplierX" DOUBLE PRECISION NOT NULL,
    "maxTotalPerSorteo" INTEGER,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BancaLoteriaSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketCounter" (
    "id" TEXT NOT NULL,
    "currentNumber" INTEGER NOT NULL DEFAULT 1,
    "lastUpdate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "ticketNumber" INTEGER NOT NULL,
    "loteriaId" TEXT NOT NULL,
    "ventanaId" TEXT NOT NULL,
    "vendedorId" TEXT NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'PENDING',
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Jugada" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "finalMultiplierX" DOUBLE PRECISION NOT NULL,
    "payout" DOUBLE PRECISION NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Jugada_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" "ActivityType" NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Banca_name_key" ON "Banca"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Banca_code_key" ON "Banca"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Ventana_code_key" ON "Ventana"("code");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Loteria_name_key" ON "Loteria"("name");

-- CreateIndex
CREATE UNIQUE INDEX "BancaLoteriaSetting_bancaId_loteriaId_key" ON "BancaLoteriaSetting"("bancaId", "loteriaId");

-- AddForeignKey
ALTER TABLE "Ventana" ADD CONSTRAINT "Ventana_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_ventanaId_fkey" FOREIGN KEY ("ventanaId") REFERENCES "Ventana"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BancaLoteriaSetting" ADD CONSTRAINT "BancaLoteriaSetting_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BancaLoteriaSetting" ADD CONSTRAINT "BancaLoteriaSetting_loteriaId_fkey" FOREIGN KEY ("loteriaId") REFERENCES "Loteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_loteriaId_fkey" FOREIGN KEY ("loteriaId") REFERENCES "Loteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_ventanaId_fkey" FOREIGN KEY ("ventanaId") REFERENCES "Ventana"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_vendedorId_fkey" FOREIGN KEY ("vendedorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Jugada" ADD CONSTRAINT "Jugada_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
