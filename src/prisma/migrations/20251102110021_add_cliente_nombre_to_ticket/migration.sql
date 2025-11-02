-- AlterTable: Add clienteNombre column to Ticket
-- This column stores the customer name for each ticket
-- Default value: "CLIENTE CONTADO" (cash customer / walk-in customer)
-- VARCHAR(100) to support names with accents and special characters

ALTER TABLE "Ticket" ADD COLUMN "clienteNombre" VARCHAR(100) DEFAULT 'CLIENTE CONTADO';
