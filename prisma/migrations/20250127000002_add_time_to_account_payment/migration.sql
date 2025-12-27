-- AlterTable
-- ✅ NUEVO: Agregar campo time (HH:MM) opcional a AccountPayment
-- Este campo permite especificar la hora del movimiento para intercalar correctamente con sorteos
ALTER TABLE "AccountPayment" ADD COLUMN "time" VARCHAR(5);

-- ✅ NOTA: El campo es opcional (NULL permitido) para mantener compatibilidad con registros existentes
-- Los registros antiguos tendrán time = NULL y usarán createdAt para el ordenamiento cronológico

