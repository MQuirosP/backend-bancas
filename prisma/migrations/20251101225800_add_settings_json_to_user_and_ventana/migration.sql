-- AlterTable: Agregar campo settings a User
ALTER TABLE "User"
ADD COLUMN "settings" JSONB;

-- AlterTable: Agregar campo settings a Ventana
ALTER TABLE "Ventana"
ADD COLUMN "settings" JSONB;
