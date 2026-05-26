-- =====================================================================
-- CURACIÓN DE DATOS (BACKFILL MULTI-TENANT) PARA EJECUTAR EN SUPABASE
-- =====================================================================
-- Instrucciones: Ejecuta estas consultas UNA POR UNA en el Editor SQL de Supabase.
-- De esta forma tienes control total y es muchísimo más rápido que NodeJS.

-- 1. Actualizar Usuarios
UPDATE "User" u 
SET "bancaId" = v."bancaId" 
FROM "Ventana" v 
WHERE u."ventanaId" = v.id 
AND u."bancaId" IS NULL;

-- 2. Actualizar Tickets
UPDATE "Ticket" t 
SET "bancaId" = v."bancaId" 
FROM "Ventana" v 
WHERE t."ventanaId" = v.id 
AND t."bancaId" IS NULL;

-- 3. Actualizar AccountStatements
UPDATE "AccountStatement" a 
SET "bancaId" = v."bancaId" 
FROM "Ventana" v 
WHERE a."ventanaId" = v.id 
AND a."bancaId" IS NULL;

-- 4. Actualizar AccountPayments
UPDATE "AccountPayment" p 
SET "bancaId" = v."bancaId" 
FROM "Ventana" v 
WHERE p."ventanaId" = v.id 
AND p."bancaId" IS NULL;

-- =====================================================================
-- 5. Actualizar Jugadas (⚠️ ATENCIÓN: Tabla Pesada ~3.6M+)
-- =====================================================================
-- IMPORTANTE: El editor de Supabase tiene un límite de 15 o 30 segundos.
-- Para evitar que se cancele la consulta, debes correr esto TODO JUNTO:

BEGIN;
-- Aumentamos el límite de tiempo solo para esta transacción a 10 minutos
SET LOCAL statement_timeout = '10min';

UPDATE "Jugada" j 
SET "bancaId" = t."bancaId" 
FROM "Ticket" t 
WHERE j."ticketId" = t.id 
AND j."bancaId" IS NULL;

COMMIT;
