-- DropIndex
DROP INDEX IF EXISTS "TicketCounter_businessDate_ventanaId_last_key";

-- AlterTable: Agregar nueva columna global_last para el contador global
ALTER TABLE "TicketCounter" ADD COLUMN "global_last" INTEGER;

-- Migrar datos: Consolidar contadores por businessDate (tomar el máximo)
UPDATE "TicketCounter" AS tc
SET "global_last" = (
  SELECT MAX("last")
  FROM "TicketCounter"
  WHERE "businessDate" = tc."businessDate"
);

-- Eliminar filas duplicadas, manteniendo solo una fila por businessDate
DELETE FROM "TicketCounter" tc1
WHERE EXISTS (
  SELECT 1
  FROM "TicketCounter" tc2
  WHERE tc2."businessDate" = tc1."businessDate"
  AND tc2.ctid < tc1.ctid
);

-- DropConstraint: Eliminar clave primaria compuesta
ALTER TABLE "TicketCounter" DROP CONSTRAINT "TicketCounter_pkey";

-- AlterTable: Eliminar ventanaId y renombrar global_last a last
ALTER TABLE "TicketCounter" DROP COLUMN "ventanaId";
ALTER TABLE "TicketCounter" DROP COLUMN "last";
ALTER TABLE "TicketCounter" RENAME COLUMN "global_last" TO "last";

-- AlterTable: Hacer last NOT NULL con default
ALTER TABLE "TicketCounter" ALTER COLUMN "last" SET NOT NULL;
ALTER TABLE "TicketCounter" ALTER COLUMN "last" SET DEFAULT 0;

-- AddPrimaryKey: Agregar nueva clave primaria simple
ALTER TABLE "TicketCounter" ADD CONSTRAINT "TicketCounter_pkey" PRIMARY KEY ("businessDate");
