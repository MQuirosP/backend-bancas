--  Agregar campo listeroCommissionAmount a Jugada para snapshot de comisión del listero
-- Este campo almacena la comisión del listero (ventana) calculada desde políticas VENTANA/BANCA
-- al momento de crear el ticket, permitiendo cálculos rápidos sin recalcular desde políticas

ALTER TABLE "Jugada" ADD COLUMN "listeroCommissionAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Crear índice para búsquedas rápidas
CREATE INDEX IF NOT EXISTS "Jugada_listeroCommissionAmount_idx" ON "Jugada"("listeroCommissionAmount") WHERE "deletedAt" IS NULL;

-- Comentario para documentación
COMMENT ON COLUMN "Jugada"."listeroCommissionAmount" IS 'Snapshot inmutable: comisión del listero (ventana) calculada desde políticas VENTANA/BANCA al crear el ticket';

