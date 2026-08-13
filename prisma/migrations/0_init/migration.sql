Loaded Prisma config from prisma.config.ts.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "OverrideScope" AS ENUM ('USER', 'VENTANA');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'VENTANA', 'VENDEDOR', 'BANCA');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO', 'CANCELLED', 'RESTORED', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "SorteoStatus" AS ENUM ('SCHEDULED', 'OPEN', 'EVALUATED', 'CLOSED');

-- CreateEnum
CREATE TYPE "BetType" AS ENUM ('NUMERO', 'REVENTADO');

-- CreateEnum
CREATE TYPE "MultiplierKind" AS ENUM ('NUMERO', 'REVENTADO');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('LOGIN', 'LOGOUT', 'PASSWORD_CHANGE', 'TICKET_CREATE', 'TICKET_CANCEL', 'TICKET_EVALUATE', 'TICKET_RESTORE', 'JUGADA_EVALUATE', 'JUGADA_RESTORE', 'SORTEO_CREATE', 'SORTEO_EVALUATE', 'SORTEO_CLOSE', 'SORTEO_REOPEN', 'LOTERIA_CREATE', 'LOTERIA_UPDATE', 'LOTERIA_DELETE', 'LOTERIA_RESTORE', 'MULTIPLIER_SETTING_CREATE', 'MULTIPLIER_SETTING_UPDATE', 'MULTIPLIER_SETTING_DELETE', 'MULTIPLIER_SETTING_RESTORE', 'BANCA_CREATE', 'BANCA_UPDATE', 'BANCA_DELETE', 'BANCA_RESTORE', 'VENTANA_CREATE', 'VENTANA_UPDATE', 'VENTANA_DELETE', 'VENTANA_RESTORE', 'USER_CREATE', 'USER_UPDATE', 'USER_DELETE', 'USER_RESTORE', 'USER_ROLE_CHANGE', 'SOFT_DELETE', 'RESTORE', 'SYSTEM_ACTION', 'SORTEO_UPDATE', 'TICKET_PAY', 'TICKET_PAYMENT_REVERSE', 'TICKET_PAY_FINALIZE', 'TICKET_STATUS_PAID', 'SORTEO_OPEN', 'ACCOUNT_STATEMENT_VIEW', 'ACCOUNT_STATEMENT_DELETE', 'ACCOUNT_PAYMENT_CREATE', 'ACCOUNT_PAYMENT_REVERSE', 'ACCOUNT_PAYMENT_HISTORY_VIEW', 'TICKET_REPRINT');

-- CreateEnum
CREATE TYPE "ExportFormat" AS ENUM ('CSV', 'XLSX', 'JSON');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

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
    "salesCutoffMinutes" INTEGER NOT NULL DEFAULT 1,
    "commissionPolicyJson" JSONB,
    "maxSessionsPerVendedor" INTEGER NOT NULL DEFAULT 1,
    "vendorLimit" INTEGER,

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
    "commissionPolicyJson" JSONB,
    "settings" JSONB,

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
    "commissionPolicyJson" JSONB,
    "settings" JSONB,
    "platform" TEXT,
    "appVersion" VARCHAR(50),
    "bancaId" UUID,
    "maxSessionsPerVendedor" INTEGER,

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
    "bancaId" UUID,

    CONSTRAINT "Loteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BancaLoteriaSetting" (
    "id" UUID NOT NULL,
    "loteriaId" UUID NOT NULL,
    "baseMultiplierX" DOUBLE PRECISION NOT NULL,
    "maxTotalPerSorteo" INTEGER,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "bancaId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "BancaLoteriaSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" UUID NOT NULL,
    "ticketNumber" VARCHAR(24) NOT NULL DEFAULT generate_ticket_number(),
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
    "totalPayout" DOUBLE PRECISION DEFAULT 0,
    "totalPaid" DOUBLE PRECISION DEFAULT 0,
    "remainingAmount" DOUBLE PRECISION DEFAULT 0,
    "lastPaymentAt" TIMESTAMP(3),
    "paidById" UUID,
    "paymentMethod" TEXT,
    "paymentNotes" TEXT,
    "paymentHistory" JSONB,
    "clienteNombre" VARCHAR(100) DEFAULT 'CLIENTE CONTADO',
    "businessDate" DATE,
    "totalCommission" DOUBLE PRECISION DEFAULT 0,
    "createdBy" UUID,
    "createdByRole" "Role",
    "isSorteoClosed" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT,
    "bancaId" UUID,
    "printCount" INTEGER DEFAULT 0,
    "totalListeroCommission" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketCounter" (
    "businessDate" DATE NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TicketCounter_pkey" PRIMARY KEY ("businessDate")
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
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),

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
    "commissionPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "commissionAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "commissionOrigin" TEXT,
    "commissionRuleId" TEXT,
    "listeroCommissionAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isExcluded" BOOLEAN NOT NULL DEFAULT false,
    "excludedAt" TIMESTAMP(3),
    "excludedBy" UUID,
    "excludedReason" TEXT,
    "bancaId" UUID,

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
    "hasWinner" BOOLEAN NOT NULL DEFAULT false,
    "deletedByCascadeFrom" TEXT,
    "deletedByCascadeId" UUID,
    "deletedByCascade" BOOLEAN NOT NULL DEFAULT false,
    "digits" INTEGER NOT NULL DEFAULT 2,
    "bancaId" UUID,

    CONSTRAINT "Sorteo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sorteo_lista_exclusion" (
    "id" UUID NOT NULL,
    "sorteo_id" UUID NOT NULL,
    "ventana_id" UUID NOT NULL,
    "vendedor_id" UUID,
    "excluded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "excluded_by" UUID NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "multiplier_id" UUID,
    "banca_id" UUID,

    CONSTRAINT "sorteo_lista_exclusion_pkey" PRIMARY KEY ("id")
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
    "bancaId" UUID,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestrictionRule" (
    "id" UUID NOT NULL,
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
    "loteriaId" UUID,
    "multiplierId" UUID,
    "message" VARCHAR(255),
    "isAutoDate" BOOLEAN NOT NULL DEFAULT false,
    "baseAmount" DOUBLE PRECISION,
    "salesPercentage" DOUBLE PRECISION,
    "appliesToVendedor" BOOLEAN NOT NULL DEFAULT false,
    "bancaId" UUID,

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
    "bancaId" UUID,

    CONSTRAINT "LoteriaMultiplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MultiplierOverride" (
    "id" UUID NOT NULL,
    "scope" "OverrideScope" NOT NULL,
    "userId" UUID,
    "ventanaId" UUID,
    "loteriaId" UUID NOT NULL,
    "multiplierType" TEXT NOT NULL,
    "baseMultiplierX" DOUBLE PRECISION NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "bancaId" UUID,

    CONSTRAINT "MultiplierOverride_pkey" PRIMARY KEY ("id")
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
    "deviceId" VARCHAR(255),
    "deviceName" VARCHAR(255),
    "userAgent" TEXT,
    "ipAddress" VARCHAR(45),
    "lastUsedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" VARCHAR(50),
    "bancaId" UUID,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBanca" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "bancaId" UUID NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserBanca_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedReport" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "filters" JSONB NOT NULL,
    "schedule" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "bancaId" UUID,

    CONSTRAINT "SavedReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportJob" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "format" "ExportFormat" NOT NULL DEFAULT 'CSV',
    "filters" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "fileUrl" TEXT,
    "errorMessage" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "totalRecords" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "bancaId" UUID,

    CONSTRAINT "ExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "dimension" TEXT NOT NULL,
    "targetId" TEXT,
    "condition" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastFiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "notifyEmail" TEXT,
    "notifyWebhook" TEXT,
    "bancaId" UUID,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "userId" UUID,
    "scopes" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "bancaId" UUID,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Webhook" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "secret" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastFiredAt" TIMESTAMP(3),
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "bancaId" UUID,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" UUID NOT NULL,
    "webhookId" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" INTEGER NOT NULL,
    "responseBody" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportSchedule" (
    "id" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "frequency" TEXT NOT NULL,
    "recipients" TEXT[],
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Goal" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "targetId" TEXT,
    "targetValue" DOUBLE PRECISION NOT NULL,
    "period" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "bancaId" UUID,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountStatement" (
    "id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "ventanaId" UUID,
    "vendedorId" UUID,
    "totalSales" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalPayouts" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "listeroCommission" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "vendedorCommission" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "remainingBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isSettled" BOOLEAN NOT NULL DEFAULT false,
    "canEdit" BOOLEAN NOT NULL DEFAULT true,
    "ticketCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "totalCollected" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "settledAt" TIMESTAMP(3),
    "settledBy" UUID,
    "accumulatedBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bancaId" UUID,

    CONSTRAINT "AccountStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountPayment" (
    "id" UUID NOT NULL,
    "accountStatementId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "ventanaId" UUID,
    "vendedorId" UUID,
    "amount" DOUBLE PRECISION NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "method" VARCHAR(20) NOT NULL,
    "notes" TEXT,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "isReversed" BOOLEAN NOT NULL DEFAULT false,
    "reversedAt" TIMESTAMP(3),
    "reversedBy" UUID,
    "paidById" UUID NOT NULL,
    "paidByName" VARCHAR(255) NOT NULL,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "time" VARCHAR(5),
    "bancaId" UUID,

    CONSTRAINT "AccountPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SorteosAutoConfig" (
    "id" UUID NOT NULL,
    "autoOpenEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoCreateEnabled" BOOLEAN NOT NULL DEFAULT false,
    "openCronSchedule" TEXT,
    "createCronSchedule" TEXT,
    "lastOpenExecution" TIMESTAMP(3),
    "lastCreateExecution" TIMESTAMP(3),
    "lastOpenCount" INTEGER,
    "lastCreateCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" UUID,
    "autoCloseEnabled" BOOLEAN NOT NULL DEFAULT false,
    "closeCronSchedule" TEXT,
    "lastCloseExecution" TIMESTAMP(3),
    "lastCloseCount" INTEGER,
    "bancaId" UUID,

    CONSTRAINT "SorteosAutoConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountStatementSettlementConfig" (
    "id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "settlementAgeDays" INTEGER NOT NULL DEFAULT 7,
    "cronSchedule" VARCHAR(50),
    "batchSize" INTEGER NOT NULL DEFAULT 1000,
    "lastExecution" TIMESTAMP(3),
    "lastSettledCount" INTEGER,
    "lastSkippedCount" INTEGER,
    "lastErrorCount" INTEGER,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" UUID,
    "bancaId" UUID,

    CONSTRAINT "AccountStatementSettlementConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyClosingBalance" (
    "id" UUID NOT NULL,
    "closingMonth" VARCHAR(7) NOT NULL,
    "dimension" VARCHAR(20) NOT NULL,
    "vendedorId" UUID,
    "ventanaId" UUID,
    "closingBalance" DECIMAL(15,2) NOT NULL,
    "totalSales" DECIMAL(15,2) NOT NULL,
    "totalPayouts" DECIMAL(15,2) NOT NULL,
    "totalCommission" DECIMAL(15,2) NOT NULL,
    "totalPaid" DECIMAL(15,2) NOT NULL,
    "totalCollected" DECIMAL(15,2) NOT NULL,
    "ticketCount" INTEGER NOT NULL,
    "closingDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "bancaId" UUID,

    CONSTRAINT "MonthlyClosingBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResumenCierreDiario" (
    "id" UUID NOT NULL,
    "bancaId" UUID,
    "businessDate" DATE NOT NULL,
    "vendedorId" UUID NOT NULL,
    "ventanaId" UUID NOT NULL,
    "loteriaId" UUID NOT NULL,
    "sorteoId" UUID NOT NULL,
    "tipo" "BetType" NOT NULL,
    "banda" DOUBLE PRECISION NOT NULL,
    "totalVendida" DOUBLE PRECISION NOT NULL,
    "ganado" DOUBLE PRECISION NOT NULL,
    "comisionTotal" DOUBLE PRECISION NOT NULL,
    "ticketsCount" INTEGER NOT NULL,
    "jugadasCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResumenCierreDiario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyNumberSales" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "businessDate" DATE NOT NULL,
    "bancaId" UUID NOT NULL,
    "ventanaId" UUID NOT NULL,
    "vendedorId" UUID NOT NULL,
    "loteriaId" UUID NOT NULL,
    "sorteoId" UUID NOT NULL,
    "number" VARCHAR(10) NOT NULL,
    "type" "BetType" NOT NULL DEFAULT 'NUMERO',
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "ticketsCount" INTEGER NOT NULL,
    "jugadasCount" INTEGER NOT NULL,

    CONSTRAINT "DailyNumberSales_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Banca_name_key" ON "Banca"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Banca_code_key" ON "Banca"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Ventana_code_key" ON "Ventana"("code");

-- CreateIndex
CREATE INDEX "Ventana_name_idx" ON "Ventana"("name");

-- CreateIndex
CREATE INDEX "idx_ventana_bancaId_fk" ON "Ventana"("bancaId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_code_key" ON "User"("code");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_name_idx" ON "User"("name");

-- CreateIndex
CREATE INDEX "User_username_idx" ON "User"("username");

-- CreateIndex
CREATE INDEX "User_bancaId_idx" ON "User"("bancaId");

-- CreateIndex
CREATE INDEX "idx_user_banca_role" ON "User"("bancaId", "role");

-- CreateIndex
CREATE INDEX "idx_user_code_trgm" ON "User" USING GIN ("code" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "idx_user_name_trgm" ON "User" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "idx_user_banca_vendedor" ON "User"("bancaId") WHERE (role = 'VENDEDOR'::"Role");

-- CreateIndex
CREATE INDEX "idx_user_ventana_role_active" ON "User"("ventanaId", "role", "isActive") WHERE (("deletedAt" IS NULL) AND ("isActive" = true));

-- CreateIndex
CREATE INDEX "Loteria_name_idx" ON "Loteria"("name");

-- CreateIndex
CREATE INDEX "Loteria_bancaId_idx" ON "Loteria"("bancaId");

-- CreateIndex
CREATE UNIQUE INDEX "Loteria_name_bancaId_key" ON "Loteria"("name", "bancaId");

-- CreateIndex
CREATE INDEX "BancaLoteriaSetting_bancaId_idx" ON "BancaLoteriaSetting"("bancaId");

-- CreateIndex
CREATE INDEX "idx_bancaloteriasetting_loteriaId_fk" ON "BancaLoteriaSetting"("loteriaId");

-- CreateIndex
CREATE UNIQUE INDEX "BancaLoteriaSetting_bancaId_loteriaId_key" ON "BancaLoteriaSetting"("bancaId", "loteriaId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_ticketNumber_key" ON "Ticket"("ticketNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_idempotencyKey_key" ON "Ticket"("idempotencyKey") WHERE ("idempotencyKey" IS NOT NULL);

-- CreateIndex
CREATE INDEX "Ticket_bancaId_idx" ON "Ticket"("bancaId");

-- CreateIndex
CREATE INDEX "Ticket_vendedorId_sorteoId_deletedAt_isActive_idx" ON "Ticket"("vendedorId", "sorteoId", "deletedAt", "isActive");

-- CreateIndex
CREATE INDEX "Ticket_ventanaId_businessDate_deletedAt_idx" ON "Ticket"("ventanaId", "businessDate", "deletedAt");

-- CreateIndex
CREATE INDEX "idx_Ticket_loteriaId" ON "Ticket"("loteriaId");

-- CreateIndex
CREATE INDEX "idx_ticket_cierre_consolidado" ON "Ticket"("businessDate", "isActive", "status", "deletedAt", "vendedorId", "sorteoId", "ventanaId");

-- CreateIndex
CREATE INDEX "idx_ticket_banca_sorteo_winner_perf" ON "Ticket"("bancaId", "sorteoId") WHERE (("isActive" = true) AND ("isWinner" = true) AND ("deletedAt" IS NULL));

-- CreateIndex
CREATE INDEX "idx_ticket_business_date_sorteo" ON "Ticket"("businessDate", "sorteoId", "isActive") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE INDEX "idx_ticket_business_date_ventana_vendedor" ON "Ticket"("businessDate", "ventanaId", "vendedorId") WHERE (("deletedAt" IS NULL) AND (status <> 'CANCELLED'::"TicketStatus"));

-- CreateIndex
CREATE INDEX "idx_ticket_created_at" ON "Ticket"("createdAt") WHERE (("deletedAt" IS NULL) AND (status <> 'CANCELLED'::"TicketStatus"));

-- CreateIndex
CREATE INDEX "idx_ticket_risk_banca_date" ON "Ticket"("bancaId", "businessDate", "isActive", "status") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE INDEX "idx_ticket_sorteo_status" ON "Ticket"("sorteoId", "status", "isActive") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE INDEX "idx_ticket_winner_status_date" ON "Ticket"("isWinner", "status", "createdAt") WHERE (("isActive" = true) AND ("deletedAt" IS NULL));

-- CreateIndex
CREATE INDEX "idx_tickets_ventana_vendedor_date" ON "Ticket"("ventanaId", "vendedorId", "businessDate", "status") WHERE (("deletedAt" IS NULL) AND ("isActive" = true) AND (status <> 'CANCELLED'::"TicketStatus"));

-- CreateIndex
CREATE INDEX "Ticket_status_isWinner_idx" ON "Ticket"("status", "isWinner");

-- CreateIndex
CREATE INDEX "idx_ticket_businessdate_ventana" ON "Ticket"("businessDate", "ventanaId");

-- CreateIndex
CREATE INDEX "idx_ticket_dashboard_lookup" ON "Ticket"("bancaId", "ventanaId", "businessDate", "status") WHERE (("deletedAt" IS NULL) AND ("isActive" = true));

-- CreateIndex
CREATE INDEX "idx_ticket_sorteo_businessdate_active" ON "Ticket"("sorteoId", "businessDate", "isActive");

-- CreateIndex
CREATE INDEX "idx_ticket_winners_perf" ON "Ticket"("businessDate", "ventanaId", "vendedorId") WHERE (("isWinner" = true) AND ("isActive" = true) AND ("deletedAt" IS NULL));

-- CreateIndex
CREATE UNIQUE INDEX "idx_ticketcounter_date_unique" ON "TicketCounter"("businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "TicketPayment_idempotencyKey_key" ON "TicketPayment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "TicketPayment_ticketId_isReversed_idx" ON "TicketPayment"("ticketId", "isReversed");

-- CreateIndex
CREATE INDEX "TicketPayment_ticketId_createdAt_idx" ON "TicketPayment"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "idx_ticketpayment_paidById_fk" ON "TicketPayment"("paidById");

-- CreateIndex
CREATE INDEX "idx_jugada_exclusiones_lookup" ON "Jugada"("ticketId", "multiplierId") WHERE (("deletedAt" IS NULL) AND ("isActive" = true));

-- CreateIndex
CREATE INDEX "idx_jugada_maestro_final" ON "Jugada"("ticketId", "number", "type", "isActive", "isExcluded", "amount", "payout", "listeroCommissionAmount", "finalMultiplierX") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE INDEX "idx_jugada_number_amount_active" ON "Jugada"("number", "ticketId", "amount", "type") WHERE (("deletedAt" IS NULL) AND ("isActive" = true));

-- CreateIndex
CREATE INDEX "idx_jugada_ticket_winner" ON "Jugada"("ticketId", "isWinner", "deletedAt", "payout") WHERE (("deletedAt" IS NULL) AND ("isWinner" = true));

-- CreateIndex
CREATE INDEX "Jugada_ticketId_idx" ON "Jugada"("ticketId");

-- CreateIndex
CREATE INDEX "idx_jugada_bancaid_multiplier_counts" ON "Jugada"("bancaId", "ticketId", "multiplierId") WHERE (("deletedAt" IS NULL) AND ("isActive" = true) AND (type = 'NUMERO'::"BetType") AND ("multiplierId" IS NOT NULL));

-- CreateIndex
CREATE INDEX "idx_jugada_ticket_commission_covering_full" ON "Jugada"("ticketId", "type", "commissionAmount");

-- CreateIndex
CREATE INDEX "idx_sorteos_loteria_id_deleted_at" ON "Sorteo"("loteriaId", "deletedAt");

-- CreateIndex
CREATE INDEX "Sorteo_bancaId_idx" ON "Sorteo"("bancaId");

-- CreateIndex
CREATE INDEX "Sorteo_extraMultiplierId_idx" ON "Sorteo"("extraMultiplierId");

-- CreateIndex
CREATE INDEX "Sorteo_name_idx" ON "Sorteo"("name");

-- CreateIndex
CREATE INDEX "Sorteo_winningNumber_idx" ON "Sorteo"("winningNumber");

-- CreateIndex
CREATE INDEX "idx_sorteo_name_trgm" ON "Sorteo" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "idx_sorteo_status_open" ON "Sorteo"("id") WHERE (status = 'OPEN'::"SorteoStatus");

-- CreateIndex
CREATE INDEX "idx_sorteo_status_scheduled" ON "Sorteo"("status", "scheduledAt", "loteriaId") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE INDEX "idx_sorteo_id_status" ON "Sorteo"("id", "status");

-- CreateIndex
CREATE INDEX "idx_sorteo_scheduled_at" ON "Sorteo"("scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "Sorteo_loteriaId_scheduledAt_bancaId_key" ON "Sorteo"("loteriaId", "scheduledAt", "bancaId");

-- CreateIndex
CREATE INDEX "sorteo_lista_exclusion_sorteo_id_idx" ON "sorteo_lista_exclusion"("sorteo_id");

-- CreateIndex
CREATE INDEX "sorteo_lista_exclusion_ventana_id_idx" ON "sorteo_lista_exclusion"("ventana_id");

-- CreateIndex
CREATE INDEX "sorteo_lista_exclusion_vendedor_id_idx" ON "sorteo_lista_exclusion"("vendedor_id");

-- CreateIndex
CREATE INDEX "sorteo_lista_exclusion_banca_id_idx" ON "sorteo_lista_exclusion"("banca_id");

-- CreateIndex
CREATE INDEX "sorteo_lista_exclusion_multiplier_id_idx" ON "sorteo_lista_exclusion"("multiplier_id");

-- CreateIndex
CREATE INDEX "idx_sorteo_lista_exclusion_exBy_fk" ON "sorteo_lista_exclusion"("excluded_by");

-- CreateIndex
CREATE INDEX "idx_sorteo_exclusion_lookup" ON "sorteo_lista_exclusion"("sorteo_id", "ventana_id", "vendedor_id") WHERE (multiplier_id IS NULL);

-- CreateIndex
CREATE INDEX "idx_sle_multiplier_lookup" ON "sorteo_lista_exclusion"("sorteo_id", "ventana_id", "vendedor_id", "multiplier_id") WHERE (multiplier_id IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "sorteo_lista_exclusion_sorteo_ventana_vendedor_multiplier_key" ON "sorteo_lista_exclusion"("sorteo_id", "ventana_id", "vendedor_id", "multiplier_id");

-- CreateIndex
CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_bancaId_idx" ON "ActivityLog"("bancaId");

-- CreateIndex
CREATE INDEX "ActivityLog_targetType_idx" ON "ActivityLog"("targetType");

-- CreateIndex
CREATE INDEX "idx_activity_log_target_date" ON "ActivityLog"("bancaId", "targetType", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "idx_activity_log_user_id" ON "ActivityLog"("userId");

-- CreateIndex
CREATE INDEX "RestrictionRule_loteriaId_idx" ON "RestrictionRule"("loteriaId");

-- CreateIndex
CREATE INDEX "RestrictionRule_multiplierId_idx" ON "RestrictionRule"("multiplierId");

-- CreateIndex
CREATE INDEX "RestrictionRule_bancaId_idx" ON "RestrictionRule"("bancaId");

-- CreateIndex
CREATE INDEX "idx_restriction_number_active" ON "RestrictionRule"("number", "isActive", "loteriaId") WHERE (("isActive" = true) AND (number IS NOT NULL));

-- CreateIndex
CREATE INDEX "idx_restriction_rule_auto_date_active" ON "RestrictionRule"("isAutoDate", "isActive") WHERE (("isAutoDate" = true) AND ("isActive" = true));

-- CreateIndex
CREATE INDEX "idx_restriction_rules_sales_percentage" ON "RestrictionRule"("salesPercentage") WHERE ("salesPercentage" IS NOT NULL);

-- CreateIndex
CREATE INDEX "idx_restrictionrule_userId_fk" ON "RestrictionRule"("userId");

-- CreateIndex
CREATE INDEX "idx_restrictionrule_ventanaId_fk" ON "RestrictionRule"("ventanaId");

-- CreateIndex
CREATE INDEX "LoteriaMultiplier_loteriaId_kind_isActive_idx" ON "LoteriaMultiplier"("loteriaId", "kind", "isActive");

-- CreateIndex
CREATE INDEX "LoteriaMultiplier_bancaId_idx" ON "LoteriaMultiplier"("bancaId");

-- CreateIndex
CREATE INDEX "LoteriaMultiplier_appliesToSorteoId_idx" ON "LoteriaMultiplier"("appliesToSorteoId");

-- CreateIndex
CREATE INDEX "idx_override_lookup" ON "MultiplierOverride"("scope", "userId", "ventanaId", "loteriaId", "multiplierType");

-- CreateIndex
CREATE INDEX "MultiplierOverride_bancaId_idx" ON "MultiplierOverride"("bancaId");

-- CreateIndex
CREATE INDEX "idx_multiplieroverride_loteriaId_fk" ON "MultiplierOverride"("loteriaId");

-- CreateIndex
CREATE INDEX "idx_multiplieroverride_userId_fk" ON "MultiplierOverride"("userId");

-- CreateIndex
CREATE INDEX "idx_multiplieroverride_ventanaId_fk" ON "MultiplierOverride"("ventanaId");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_override_scope_target" ON "MultiplierOverride"("scope", "userId", "ventanaId", "loteriaId", "multiplierType");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_token_key" ON "RefreshToken"("token");

-- CreateIndex
CREATE INDEX "idx_refresh_token_user_id" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "idx_refreshtoken_pool_count" ON "RefreshToken"("bancaId", "revoked", "expiresAt");

-- CreateIndex
CREATE INDEX "idx_refresh_token_user_device" ON "RefreshToken"("userId", "deviceId") WHERE ("deviceId" IS NOT NULL);

-- CreateIndex
CREATE INDEX "idx_refresh_token_expires_at" ON "RefreshToken"("expiresAt");

-- CreateIndex
CREATE INDEX "UserBanca_userId_idx" ON "UserBanca"("userId");

-- CreateIndex
CREATE INDEX "UserBanca_bancaId_idx" ON "UserBanca"("bancaId");

-- CreateIndex
CREATE INDEX "UserBanca_isDefault_idx" ON "UserBanca"("userId", "isDefault") WHERE ("isDefault" = true);

-- CreateIndex
CREATE UNIQUE INDEX "UserBanca_userId_bancaId_unique" ON "UserBanca"("userId", "bancaId");

-- CreateIndex
CREATE INDEX "SavedReport_userId_isActive_idx" ON "SavedReport"("userId", "isActive");

-- CreateIndex
CREATE INDEX "SavedReport_bancaId_idx" ON "SavedReport"("bancaId");

-- CreateIndex
CREATE UNIQUE INDEX "ExportJob_idempotencyKey_key" ON "ExportJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ExportJob_userId_status_idx" ON "ExportJob"("userId", "status");

-- CreateIndex
CREATE INDEX "ExportJob_bancaId_idx" ON "ExportJob"("bancaId");

-- CreateIndex
CREATE INDEX "Alert_userId_isActive_idx" ON "Alert"("userId", "isActive");

-- CreateIndex
CREATE INDEX "Alert_bancaId_idx" ON "Alert"("bancaId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_key_key" ON "ApiKey"("key");

-- CreateIndex
CREATE INDEX "ApiKey_key_isActive_idx" ON "ApiKey"("key", "isActive");

-- CreateIndex
CREATE INDEX "ApiKey_userId_isActive_idx" ON "ApiKey"("userId", "isActive");

-- CreateIndex
CREATE INDEX "ApiKey_bancaId_idx" ON "ApiKey"("bancaId");

-- CreateIndex
CREATE INDEX "Webhook_isActive_idx" ON "Webhook"("isActive");

-- CreateIndex
CREATE INDEX "Webhook_bancaId_idx" ON "Webhook"("bancaId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_webhookId_createdAt_idx" ON "WebhookDelivery"("webhookId", "createdAt");

-- CreateIndex
CREATE INDEX "ReportSchedule_isActive_nextRunAt_idx" ON "ReportSchedule"("isActive", "nextRunAt");

-- CreateIndex
CREATE INDEX "idx_reportschedule_reportId_fk" ON "ReportSchedule"("reportId");

-- CreateIndex
CREATE INDEX "Goal_dimension_targetId_isActive_idx" ON "Goal"("dimension", "targetId", "isActive");

-- CreateIndex
CREATE INDEX "Goal_period_isActive_idx" ON "Goal"("period", "isActive");

-- CreateIndex
CREATE INDEX "Goal_bancaId_idx" ON "Goal"("bancaId");

-- CreateIndex
CREATE INDEX "AccountStatement_month_idx" ON "AccountStatement"("month");

-- CreateIndex
CREATE INDEX "AccountStatement_date_idx" ON "AccountStatement"("date");

-- CreateIndex
CREATE INDEX "AccountStatement_bancaId_idx" ON "AccountStatement"("bancaId");

-- CreateIndex
CREATE INDEX "AccountStatement_isSettled_idx" ON "AccountStatement"("isSettled");

-- CreateIndex
CREATE INDEX "AccountStatement_isSettled_date_idx" ON "AccountStatement"("isSettled", "date");

-- CreateIndex
CREATE INDEX "AccountStatement_month_isSettled_date_idx" ON "AccountStatement"("month", "isSettled", "date");

-- CreateIndex
CREATE INDEX "AccountStatement_vendedorId_date_idx" ON "AccountStatement"("vendedorId", "date");

-- CreateIndex
CREATE INDEX "idx_account_statement_vendedor_covering_v3" ON "AccountStatement"("vendedorId", "date", "remainingBalance");

-- CreateIndex
CREATE INDEX "AccountStatement_vendedorId_idx" ON "AccountStatement"("vendedorId") WHERE ("vendedorId" IS NOT NULL);

-- CreateIndex
CREATE INDEX "AccountStatement_ventanaId_idx" ON "AccountStatement"("ventanaId") WHERE ("ventanaId" IS NOT NULL);

-- CreateIndex
CREATE INDEX "idx_account_statement_banca_sum_v3" ON "AccountStatement"("date", "remainingBalance") WHERE (("vendedorId" IS NULL) AND ("ventanaId" IS NULL));

-- CreateIndex
CREATE INDEX "idx_account_statements_month_settled" ON "AccountStatement"("month", "isSettled") WHERE ("isSettled" = true);

-- CreateIndex
CREATE INDEX "idx_accountstatement_settledBy_fk" ON "AccountStatement"("settledBy");

-- CreateIndex
CREATE INDEX "idx_as_banca_date" ON "AccountStatement"("bancaId", "date" DESC) WHERE (("ventanaId" IS NULL) AND ("vendedorId" IS NULL));

-- CreateIndex
CREATE INDEX "idx_as_vendedor_date" ON "AccountStatement"("vendedorId", "date" DESC) WHERE ("vendedorId" IS NOT NULL);

-- CreateIndex
CREATE INDEX "idx_as_ventana_date" ON "AccountStatement"("ventanaId", "date" DESC) WHERE (("ventanaId" IS NOT NULL) AND ("vendedorId" IS NULL));

-- CreateIndex
CREATE UNIQUE INDEX "account_statements_date_vendedor_unique" ON "AccountStatement"("date", "vendedorId");

-- CreateIndex
CREATE UNIQUE INDEX "account_statements_date_ventana_unique" ON "AccountStatement"("date", "ventanaId") WHERE (("ventanaId" IS NOT NULL) AND ("vendedorId" IS NULL));

-- CreateIndex
CREATE UNIQUE INDEX "account_statements_date_banca_unique" ON "AccountStatement"("date", "bancaId") WHERE (("ventanaId" IS NULL) AND ("vendedorId" IS NULL));

-- CreateIndex
CREATE UNIQUE INDEX "AccountPayment_idempotencyKey_key" ON "AccountPayment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AccountPayment_accountStatementId_idx" ON "AccountPayment"("accountStatementId");

-- CreateIndex
CREATE INDEX "AccountPayment_date_idx" ON "AccountPayment"("date");

-- CreateIndex
CREATE INDEX "AccountPayment_month_idx" ON "AccountPayment"("month");

-- CreateIndex
CREATE INDEX "AccountPayment_bancaId_idx" ON "AccountPayment"("bancaId");

-- CreateIndex
CREATE INDEX "AccountPayment_isReversed_idx" ON "AccountPayment"("isReversed");

-- CreateIndex
CREATE INDEX "idx_AccountPayment_paidById" ON "AccountPayment"("paidById");

-- CreateIndex
CREATE INDEX "idx_AccountPayment_reversedBy" ON "AccountPayment"("reversedBy");

-- CreateIndex
CREATE INDEX "AccountPayment_vendedorId_idx" ON "AccountPayment"("vendedorId") WHERE ("vendedorId" IS NOT NULL);

-- CreateIndex
CREATE INDEX "AccountPayment_ventanaId_idx" ON "AccountPayment"("ventanaId") WHERE ("ventanaId" IS NOT NULL);

-- CreateIndex
CREATE INDEX "idx_account_payment_date_vendedor" ON "AccountPayment"("date", "vendedorId") WHERE (("isReversed" = false) AND ("vendedorId" IS NOT NULL));

-- CreateIndex
CREATE INDEX "idx_account_payment_date_ventana" ON "AccountPayment"("date", "ventanaId") WHERE ("isReversed" = false);

-- CreateIndex
CREATE INDEX "idx_account_payment_statement_reversed_type" ON "AccountPayment"("accountStatementId", "isReversed", "type") WHERE ("isReversed" = false);

-- CreateIndex
CREATE INDEX "AccountPayment_vendedorId_idx1" ON "AccountPayment"("vendedorId");

-- CreateIndex
CREATE INDEX "SorteosAutoConfig_bancaId_idx" ON "SorteosAutoConfig"("bancaId");

-- CreateIndex
CREATE INDEX "idx_sorteosautoconfig_updatedBy_fk" ON "SorteosAutoConfig"("updatedBy");

-- CreateIndex
CREATE INDEX "AccountStatementSettlementConfig_enabled_idx" ON "AccountStatementSettlementConfig"("enabled");

-- CreateIndex
CREATE INDEX "AccountStatementSettlementConfig_bancaId_idx" ON "AccountStatementSettlementConfig"("bancaId");

-- CreateIndex
CREATE INDEX "idx_accountstatementsettlementconfig_updBy_fk" ON "AccountStatementSettlementConfig"("updatedBy");

-- CreateIndex
CREATE INDEX "MonthlyClosingBalance_closingMonth_idx" ON "MonthlyClosingBalance"("closingMonth");

-- CreateIndex
CREATE INDEX "MonthlyClosingBalance_closingDate_idx" ON "MonthlyClosingBalance"("closingDate");

-- CreateIndex
CREATE INDEX "MonthlyClosingBalance_dimension_vendedorId_ventanaId_bancaId_id" ON "MonthlyClosingBalance"("dimension", "vendedorId", "ventanaId", "bancaId");

-- CreateIndex
CREATE INDEX "idx_MonthlyClosingBalance_bancaId" ON "MonthlyClosingBalance"("bancaId");

-- CreateIndex
CREATE INDEX "idx_MonthlyClosingBalance_vendedorId" ON "MonthlyClosingBalance"("vendedorId");

-- CreateIndex
CREATE INDEX "idx_MonthlyClosingBalance_ventanaId" ON "MonthlyClosingBalance"("ventanaId");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyClosingBalance_closingMonth_dimension_vendedorId_ventana" ON "MonthlyClosingBalance"("closingMonth", "dimension", "vendedorId", "ventanaId", "bancaId");

-- CreateIndex
CREATE INDEX "ResumenCierreDiario_businessDate_idx" ON "ResumenCierreDiario"("businessDate");

-- CreateIndex
CREATE INDEX "ResumenCierreDiario_bancaId_idx" ON "ResumenCierreDiario"("bancaId");

-- CreateIndex
CREATE INDEX "ResumenCierreDiario_sorteoId_idx" ON "ResumenCierreDiario"("sorteoId");

-- CreateIndex
CREATE INDEX "ResumenCierreDiario_vendedorId_idx" ON "ResumenCierreDiario"("vendedorId");

-- CreateIndex
CREATE UNIQUE INDEX "ResumenCierreDiario_businessDate_bancaId_vendedorId_ventana_key" ON "ResumenCierreDiario"("businessDate", "bancaId", "vendedorId", "ventanaId", "loteriaId", "sorteoId", "tipo", "banda");

-- CreateIndex
CREATE INDEX "idx_daily_number_sales_banca" ON "DailyNumberSales"("businessDate", "bancaId");

-- CreateIndex
CREATE INDEX "idx_daily_number_sales_vendedor" ON "DailyNumberSales"("businessDate", "vendedorId");

-- CreateIndex
CREATE INDEX "idx_daily_number_sales_ventana" ON "DailyNumberSales"("businessDate", "ventanaId");

-- CreateIndex
CREATE INDEX "idx_dailynumbersales_sorteoid" ON "DailyNumberSales"("sorteoId");

-- CreateIndex
CREATE UNIQUE INDEX "idx_daily_number_sales_unique" ON "DailyNumberSales"("businessDate", "sorteoId", "vendedorId", "number", "type");

-- AddForeignKey
ALTER TABLE "Ventana" ADD CONSTRAINT "Ventana_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_ventanaId_fkey" FOREIGN KEY ("ventanaId") REFERENCES "Ventana"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loteria" ADD CONSTRAINT "Loteria_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BancaLoteriaSetting" ADD CONSTRAINT "BancaLoteriaSetting_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BancaLoteriaSetting" ADD CONSTRAINT "BancaLoteriaSetting_loteriaId_fkey" FOREIGN KEY ("loteriaId") REFERENCES "Loteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_loteriaId_fkey" FOREIGN KEY ("loteriaId") REFERENCES "Loteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "Jugada" ADD CONSTRAINT "Jugada_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Jugada" ADD CONSTRAINT "Jugada_excludedBy_fkey" FOREIGN KEY ("excludedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Jugada" ADD CONSTRAINT "Jugada_multiplierId_fkey" FOREIGN KEY ("multiplierId") REFERENCES "LoteriaMultiplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Jugada" ADD CONSTRAINT "Jugada_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sorteo" ADD CONSTRAINT "Sorteo_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sorteo" ADD CONSTRAINT "Sorteo_extraMultiplierId_fkey" FOREIGN KEY ("extraMultiplierId") REFERENCES "LoteriaMultiplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sorteo" ADD CONSTRAINT "Sorteo_loteriaId_fkey" FOREIGN KEY ("loteriaId") REFERENCES "Loteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sorteo_lista_exclusion" ADD CONSTRAINT "sorteo_lista_exclusion_banca_id_fkey" FOREIGN KEY ("banca_id") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sorteo_lista_exclusion" ADD CONSTRAINT "sorteo_lista_exclusion_excluded_by_fkey" FOREIGN KEY ("excluded_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sorteo_lista_exclusion" ADD CONSTRAINT "sorteo_lista_exclusion_multiplier_id_fkey" FOREIGN KEY ("multiplier_id") REFERENCES "LoteriaMultiplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sorteo_lista_exclusion" ADD CONSTRAINT "sorteo_lista_exclusion_sorteo_id_fkey" FOREIGN KEY ("sorteo_id") REFERENCES "Sorteo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sorteo_lista_exclusion" ADD CONSTRAINT "sorteo_lista_exclusion_vendedor_id_fkey" FOREIGN KEY ("vendedor_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sorteo_lista_exclusion" ADD CONSTRAINT "sorteo_lista_exclusion_ventana_id_fkey" FOREIGN KEY ("ventana_id") REFERENCES "Ventana"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestrictionRule" ADD CONSTRAINT "RestrictionRule_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestrictionRule" ADD CONSTRAINT "RestrictionRule_loteriaId_fkey" FOREIGN KEY ("loteriaId") REFERENCES "Loteria"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestrictionRule" ADD CONSTRAINT "RestrictionRule_multiplierId_fkey" FOREIGN KEY ("multiplierId") REFERENCES "LoteriaMultiplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestrictionRule" ADD CONSTRAINT "RestrictionRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestrictionRule" ADD CONSTRAINT "RestrictionRule_ventanaId_fkey" FOREIGN KEY ("ventanaId") REFERENCES "Ventana"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoteriaMultiplier" ADD CONSTRAINT "LoteriaMultiplier_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoteriaMultiplier" ADD CONSTRAINT "LoteriaMultiplier_loteriaId_fkey" FOREIGN KEY ("loteriaId") REFERENCES "Loteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MultiplierOverride" ADD CONSTRAINT "MultiplierOverride_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MultiplierOverride" ADD CONSTRAINT "MultiplierOverride_loteriaId_fkey" FOREIGN KEY ("loteriaId") REFERENCES "Loteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MultiplierOverride" ADD CONSTRAINT "MultiplierOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MultiplierOverride" ADD CONSTRAINT "MultiplierOverride_ventanaId_fkey" FOREIGN KEY ("ventanaId") REFERENCES "Ventana"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBanca" ADD CONSTRAINT "UserBanca_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBanca" ADD CONSTRAINT "UserBanca_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedReport" ADD CONSTRAINT "SavedReport_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedReport" ADD CONSTRAINT "SavedReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "SavedReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountStatement" ADD CONSTRAINT "AccountStatement_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountStatement" ADD CONSTRAINT "AccountStatement_settledBy_fkey" FOREIGN KEY ("settledBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountStatement" ADD CONSTRAINT "AccountStatement_vendedorId_fkey" FOREIGN KEY ("vendedorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountStatement" ADD CONSTRAINT "AccountStatement_ventanaId_fkey" FOREIGN KEY ("ventanaId") REFERENCES "Ventana"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountPayment" ADD CONSTRAINT "AccountPayment_accountStatementId_fkey" FOREIGN KEY ("accountStatementId") REFERENCES "AccountStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountPayment" ADD CONSTRAINT "AccountPayment_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountPayment" ADD CONSTRAINT "AccountPayment_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountPayment" ADD CONSTRAINT "AccountPayment_reversedBy_fkey" FOREIGN KEY ("reversedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountPayment" ADD CONSTRAINT "AccountPayment_vendedorId_fkey" FOREIGN KEY ("vendedorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountPayment" ADD CONSTRAINT "AccountPayment_ventanaId_fkey" FOREIGN KEY ("ventanaId") REFERENCES "Ventana"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SorteosAutoConfig" ADD CONSTRAINT "SorteosAutoConfig_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SorteosAutoConfig" ADD CONSTRAINT "SorteosAutoConfig_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountStatementSettlementConfig" ADD CONSTRAINT "AccountStatementSettlementConfig_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountStatementSettlementConfig" ADD CONSTRAINT "AccountStatementSettlementConfig_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyClosingBalance" ADD CONSTRAINT "MonthlyClosingBalance_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyClosingBalance" ADD CONSTRAINT "MonthlyClosingBalance_vendedorId_fkey" FOREIGN KEY ("vendedorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyClosingBalance" ADD CONSTRAINT "MonthlyClosingBalance_ventanaId_fkey" FOREIGN KEY ("ventanaId") REFERENCES "Ventana"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyNumberSales" ADD CONSTRAINT "DailyNumberSales_bancaId_fkey" FOREIGN KEY ("bancaId") REFERENCES "Banca"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyNumberSales" ADD CONSTRAINT "DailyNumberSales_loteriaId_fkey" FOREIGN KEY ("loteriaId") REFERENCES "Loteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyNumberSales" ADD CONSTRAINT "DailyNumberSales_sorteoId_fkey" FOREIGN KEY ("sorteoId") REFERENCES "Sorteo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyNumberSales" ADD CONSTRAINT "DailyNumberSales_vendedorId_fkey" FOREIGN KEY ("vendedorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyNumberSales" ADD CONSTRAINT "DailyNumberSales_ventanaId_fkey" FOREIGN KEY ("ventanaId") REFERENCES "Ventana"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

