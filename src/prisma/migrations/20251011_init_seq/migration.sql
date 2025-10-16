-- Extensiones necesarias (idempotentes)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "citext";

-- Secuencia local para ticket_number (fallback cuando no exista generate_ticket_number())
CREATE SEQUENCE IF NOT EXISTS ticket_number_seq
  START WITH 1
  INCREMENT BY 1
  NO MINVALUE
  NO MAXVALUE
  CACHE 1;

-- Unicidad de ticketNumber (si no existe)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ticket_ticketnumber_key'
  ) THEN
    ALTER TABLE "Ticket" ADD CONSTRAINT ticket_ticketnumber_key UNIQUE ("ticketNumber");
  END IF;
END$$;

-- Índice compuesto para agregados diarios por vendedor
CREATE INDEX IF NOT EXISTS "Ticket_vendedorId_createdAt_idx"
ON "Ticket" ("vendedorId", "createdAt");

-- (Opcional) si usas citext en User.username, asegúrate de que la columna sea CITEXT:
-- ALTER TABLE "User" ALTER COLUMN "username" TYPE CITEXT;
