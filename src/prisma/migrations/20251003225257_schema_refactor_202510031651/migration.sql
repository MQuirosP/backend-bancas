/*
  Warnings:

  - The values [SORTEO_CLOSURE,UPDATE_USER,UPDATE_MULTIPLIER_SETTING] on the enum `ActivityType` will be removed. If these variants are still used in the database, this will fail.
  - The values [PENDING,WINNER,PAID,CANCELLED] on the enum `TicketStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "ActivityType_new" AS ENUM ('LOGIN', 'LOGOUT', 'PASSWORD_CHANGE', 'TICKET_CREATE', 'TICKET_CANCEL', 'TICKET_EVALUATE', 'TICKET_RESTORE', 'JUGADA_EVALUATE', 'JUGADA_RESTORE', 'SORTEO_CREATE', 'SORTEO_EVALUATE', 'SORTEO_CLOSE', 'SORTEO_REOPEN', 'LOTERIA_CREATE', 'LOTERIA_UPDATE', 'LOTERIA_DELETE', 'LOTERIA_RESTORE', 'MULTIPLIER_SETTING_CREATE', 'MULTIPLIER_SETTING_UPDATE', 'MULTIPLIER_SETTING_DELETE', 'MULTIPLIER_SETTING_RESTORE', 'BANCA_CREATE', 'BANCA_UPDATE', 'BANCA_DELETE', 'BANCA_RESTORE', 'VENTANA_CREATE', 'VENTANA_UPDATE', 'VENTANA_DELETE', 'VENTANA_RESTORE', 'USER_CREATE', 'USER_UPDATE', 'USER_DELETE', 'USER_RESTORE', 'USER_ROLE_CHANGE', 'SOFT_DELETE', 'RESTORE', 'SYSTEM_ACTION');
ALTER TABLE "ActivityLog" ALTER COLUMN "action" TYPE "ActivityType_new" USING ("action"::text::"ActivityType_new");
ALTER TYPE "ActivityType" RENAME TO "ActivityType_old";
ALTER TYPE "ActivityType_new" RENAME TO "ActivityType";
DROP TYPE "ActivityType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "TicketStatus_new" AS ENUM ('ACTIVE', 'EVALUATED');
ALTER TABLE "Ticket" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Ticket" ALTER COLUMN "status" TYPE "TicketStatus_new" USING ("status"::text::"TicketStatus_new");
ALTER TYPE "TicketStatus" RENAME TO "TicketStatus_old";
ALTER TYPE "TicketStatus_new" RENAME TO "TicketStatus";
DROP TYPE "TicketStatus_old";
ALTER TABLE "Ticket" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
COMMIT;

-- AlterTable
ALTER TABLE "Jugada" ADD COLUMN     "isWinner" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "payout" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "isWinner" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
