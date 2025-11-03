CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
-- y que la columna username salga como CITEXT si usas @db.Citext

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'VENTANA', 'VENDEDOR');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('ACTIVE', 'EVALUATED', 'CANCELLED', 'RESTORED');

-- CreateEnum
CREATE TYPE "SorteoStatus" AS ENUM ('SCHEDULED', 'OPEN', 'EVALUATED', 'CLOSED');

-- CreateEnum
CREATE TYPE "BetType" AS ENUM ('NUMERO', 'REVENTADO');

-- CreateEnum
CREATE TYPE "MultiplierKind" AS ENUM ('NUMERO', 'REVENTADO');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('LOGIN', 'LOGOUT', 'PASSWORD_CHANGE', 'TICKET_CREATE', 'TICKET_CANCEL', 'TICKET_EVALUATE', 'TICKET_RESTORE', 'JUGADA_EVALUATE', 'JUGADA_RESTORE', 'SORTEO_CREATE', 'SORTEO_EVALUATE', 'SORTEO_CLOSE', 'SORTEO_REOPEN', 'LOTERIA_CREATE', 'LOTERIA_UPDATE', 'LOTERIA_DELETE', 'LOTERIA_RESTORE', 'MULTIPLIER_SETTING_CREATE', 'MULTIPLIER_SETTING_UPDATE', 'MULTIPLIER_SETTING_DELETE', 'MULTIPLIER_SETTING_RESTORE', 'BANCA_CREATE', 'BANCA_UPDATE', 'BANCA_DELETE', 'BANCA_RESTORE', 'VENTANA_CREATE', 'VENTANA_UPDATE', 'VENTANA_DELETE', 'VENTANA_RESTORE', 'USER_CREATE', 'USER_UPDATE', 'USER_DELETE', 'USER_RESTORE', 'USER_ROLE_CHANGE', 'SOFT_DELETE', 'RESTORE', 'SYSTEM_ACTION', 'SORTEO_UPDATE', 'TICKET_PAY', 'TICKET_PAYMENT_REVERSE', 'SORTEO_OPEN');

-- CreateTable
CREATE TABLE "Banca" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "defaultMinBet" DOUBLE PRECISION NOT NULL DEFAULT 100.00,
    "globalMaxPerNumber" INTEGER NOT NULL DEFAULT 5000,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "address" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "salesCutoffMinutes" INTEGER NOT NULL DEFAULT 5,

    CONSTRAINT "Banca_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ventana" (
    "id" UUID NOT NULL,
    "bancaId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "commissionMarginX" DOUBLE PRECISION NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "address" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Ventana_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "ventanaId" UUID,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VENTANA',
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "username" CITEXT NOT NULL,
    "code" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Loteria" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "rulesJson" JSONB,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Loteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BancaLoteriaSetting" (
    "id" UUID NOT NULL,
    "bancaId" UUID NOT NULL,
    "loteriaId" UUID NOT NULL,
    "baseMultiplierX" DOUBLE PRECISION NOT NULL,
    "maxTotalPerSorteo" INTEGER,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BancaLoteriaSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketCounter" (
    "id" TEXT NOT NULL DEFAULT 'DEFAULT',
    "currentNumber" INTEGER NOT NULL DEFAULT 0,
    "lastUpdate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" UUID NOT NULL,
    "ticketNumber" SERIAL NOT NULL,
    "loteriaId" UUID NOT NULL,
    "ventanaId" UUID NOT NULL,
    "vendedorId" UUID NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'ACTIVE',
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isWinner" BOOLEAN NOT NULL DEFAULT false,
    "sorteoId" UUID NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketPayment" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "amountPaid" DOUBLE PRECISION NOT NULL,
    "paidById" UUID NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT,
    "notes" TEXT,
    "isReversed" BOOLEAN NOT NULL DEFAULT false,
    "reversedAt" TIMESTAMP(3),
    "reversedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "idempotencyKey" TEXT,
    "isPartial" BOOLEAN NOT NULL DEFAULT false,
    "remainingAmount" DOUBLE PRECISION,

    CONSTRAINT "TicketPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Jugada" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "finalMultiplierX" DOUBLE PRECISION NOT NULL,
    "payout" DOUBLE PRECISION,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isWinner" BOOLEAN NOT NULL DEFAULT false,
    "multiplierId" UUID,
    "reventadoNumber" TEXT,
    "type" "BetType" NOT NULL DEFAULT 'NUMERO',

    CONSTRAINT "Jugada_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sorteo" (
    "id" UUID NOT NULL,
    "loteriaId" UUID NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" "SorteoStatus" NOT NULL DEFAULT 'SCHEDULED',
    "winningNumber" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "extraMultiplierId" UUID,
    "extraMultiplierX" DOUBLE PRECISION,
    "extraOutcomeCode" TEXT,

    CONSTRAINT "Sorteo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "action" "ActivityType" NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestrictionRule" (
    "id" UUID NOT NULL,
    "bancaId" UUID,
    "ventanaId" UUID,
    "userId" UUID,
    "number" TEXT,
    "maxAmount" DOUBLE PRECISION,
    "maxTotal" DOUBLE PRECISION,
    "appliesToDate" TIMESTAMP(3),
    "appliesToHour" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "salesCutoffMinutes" INTEGER,

    CONSTRAINT "RestrictionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoteriaMultiplier" (
    "id" UUID NOT NULL,
    "loteriaId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "valueX" DOUBLE PRECISION NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "appliesToDate" TIMESTAMP(3),
    "appliesToSorteoId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "kind" "MultiplierKind" NOT NULL DEFAULT 'NUMERO',

    CONSTRAINT "LoteriaMultiplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserMultiplierOverride" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "loteriaId" UUID NOT NULL,
    "baseMultiplierX" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedBy" TEXT,
    "deletedReason" TEXT,
    "multiplierType" TEXT NOT NULL,

    CONSTRAINT "UserMultiplierOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VentanaMultiplierOverride" (
    "id" UUID NOT NULL,
    "ventanaId" UUID NOT NULL,
    "loteriaId" UUID NOT NULL,
    "baseMultiplierX" DOUBLE PRECISION NOT NULL,
    "multiplierType" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VentanaMultiplierOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Banca_name_key" ON "Banca"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Banca_code_key" ON "Banca"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Ventana_code_key" ON "Ventana"("code");

-- CreateIndex
CREATE INDEX "Ventana_code_idx" ON "Ventana"("code");

-- CreateIndex
CREATE INDEX "Ventana_email_idx" ON "Ventana"("email");

-- CreateIndex
CREATE INDEX "Ventana_name_idx" ON "Ventana"("name");

-- CreateIndex
CREATE INDEX "Ventana_phone_idx" ON "Ventana"("phone");

-- CreateIndex
CREATE INDEX "idx_ventana_code_trgm" ON "Ventana" USING GIN ("code" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "idx_ventana_email_trgm" ON "Ventana" USING GIN ("email" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "idx_ventana_name_trgm" ON "Ventana" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "idx_ventana_phone_trgm" ON "Ventana" USING GIN ("phone" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_code_key" ON "User"("code");

-- CreateIndex
CREATE INDEX "User_code_idx" ON "User"("code");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_name_idx" ON "User"("name");

-- CreateIndex
CREATE INDEX "User_username_idx" ON "User"("username");

-- CreateIndex
CREATE INDEX "idx_user_code_trgm" ON "User" USING GIN ("code" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "idx_user_email_trgm" ON "User" USING GIN ("email" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "idx_user_name_trgm" ON "User" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "idx_user_username_trgm" ON "User" USING GIN ("username" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "Loteria_name_key" ON "Loteria"("name");

-- CreateIndex
CREATE INDEX "Loteria_name_idx" ON "Loteria"("name");

-- CreateIndex
CREATE INDEX "idx_loteria_name_trgm" ON "Loteria" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "BancaLoteriaSetting_bancaId_loteriaId_key" ON "BancaLoteriaSetting"("bancaId", "loteriaId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_ticketNumber_key" ON "Ticket"("ticketNumber");

-- CreateIndex
CREATE INDEX "Ticket_sorteoId_idx" ON "Ticket"("sorteoId");

-- CreateIndex
CREATE INDEX "Ticket_vendedorId_createdAt_idx" ON "Ticket"("vendedorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TicketPayment_idempotencyKey_key" ON "TicketPayment"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "TicketPayment_ticketId_isReversed_key" ON "TicketPayment"("ticketId", "isReversed");

-- CreateIndex
CREATE INDEX "Jugada_ticketId_idx" ON "Jugada"("ticketId");

-- CreateIndex
CREATE INDEX "Jugada_type_idx" ON "Jugada"("type");

-- CreateIndex
CREATE INDEX "Jugada_reventadoNumber_idx" ON "Jugada"("reventadoNumber");

-- CreateIndex
CREATE INDEX "Sorteo_loteriaId_scheduledAt_idx" ON "Sorteo"("loteriaId", "scheduledAt");

-- CreateIndex
CREATE INDEX "Sorteo_extraMultiplierId_idx" ON "Sorteo"("extraMultiplierId");

-- CreateIndex
CREATE INDEX "Sorteo_name_idx" ON "Sorteo"("name");

-- CreateIndex
CREATE INDEX "Sorteo_winningNumber_idx" ON "Sorteo"("winningNumber");

-- CreateIndex
CREATE INDEX "idx_sorteo_name_trgm" ON "Sorteo" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "idx_sorteo_winning_trgm" ON "Sorteo" USING GIN ("winningNumber" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "LoteriaMultiplier_loteriaId_kind_isActive_idx" ON "LoteriaMultiplier"("loteriaId", "kind", "isActive");

-- CreateIndex
CREATE INDEX "LoteriaMultiplier_appliesToSorteoId_idx" ON "LoteriaMultiplier"("appliesToSorteoId");

-- CreateIndex
CREATE UNIQUE INDEX "UserMultiplierOverride_userId_loteriaId_multiplierType_key" ON "UserMultiplierOverride"("userId", "loteriaId", "multiplierType");

-- CreateIndex
CREATE UNIQUE INDEX "VentanaMultiplierOverride_ventanaId_loteriaId_multiplierTyp_key" ON "VentanaMultiplierOverride"("ventanaId", "loteriaId", "multiplierType");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_token_key" ON "RefreshToken"("token");

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
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_sorteoId_fkey" FOREIGN KEY ("sorteoId") REFERENCES "Sorteo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_vendedorId_fkey" FOREIGN KEY ("vendedorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_ventanaId_fkey" FOREIGN KEY ("ventanaId") REFERENCES "Ventana"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketPayment" ADD CONSTRAINT "TicketPayment_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketPayment" ADD CONSTRAINT "TicketPayment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Jugada" ADD CONSTRAINT "Jugada_multiplierId_fkey" FOREIGN KEY ("multiplierId") REFERENCES "LoteriaMultiplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Jugada" ADD CONSTRAINT "Jugada_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sorteo" ADD CONSTRAINT "Sorteo_extraMultiplierId_fkey" FOREIGN KEY ("extraMultiplierId") REFERENCES "LoteriaMultiplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sorteo" ADD CONSTRAINT "Sorteo_loteriaId_fkey" FOREIGN KEY ("loteriaId") REFERENCES "Loteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestrictionRule" ADD CONSTRAINT "RestrictionRule_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestrictionRule" ADD CONSTRAINT "RestrictionRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestrictionRule" ADD CONSTRAINT "RestrictionRule_ventanaId_fkey" FOREIGN KEY ("ventanaId") REFERENCES "Ventana"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoteriaMultiplier" ADD CONSTRAINT "LoteriaMultiplier_loteriaId_fkey" FOREIGN KEY ("loteriaId") REFERENCES "Loteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMultiplierOverride" ADD CONSTRAINT "UserMultiplierOverride_loteriaId_fkey" FOREIGN KEY ("loteriaId") REFERENCES "Loteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMultiplierOverride" ADD CONSTRAINT "UserMultiplierOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VentanaMultiplierOverride" ADD CONSTRAINT "VentanaMultiplierOverride_ventanaId_fkey" FOREIGN KEY ("ventanaId") REFERENCES "Ventana"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VentanaMultiplierOverride" ADD CONSTRAINT "VentanaMultiplierOverride_loteriaId_fkey" FOREIGN KEY ("loteriaId") REFERENCES "Loteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
