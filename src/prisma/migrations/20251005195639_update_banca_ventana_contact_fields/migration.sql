-- AlterTable
ALTER TABLE "Banca" ADD COLUMN     "address" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "phone" TEXT,
ALTER COLUMN "defaultMinBet" SET DEFAULT 100.00;

-- AlterTable
ALTER TABLE "Ventana" ADD COLUMN     "address" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "phone" TEXT;
