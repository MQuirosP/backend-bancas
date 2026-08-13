-- Migración B: Cambiar ticketNumber de Int a String con generación automática
-- ===============================================================================
-- Esta migración modifica la columna ticketNumber para:
-- 1. Cambiar el tipo de INTEGER a VARCHAR(24)
-- 2. Cambiar el default de autoincrement() a generate_ticket_number()
-- 3. Eliminar la secuencia autoincrement antigua
--
-- IMPORTANTE: Esta migración solo funciona si no hay tickets existentes,
-- o si los tickets existentes tienen ticketNumber numérico compatible.
-- ===============================================================================

-- PASO 1: Eliminar el default anterior (autoincrement)
ALTER TABLE "Ticket" ALTER COLUMN "ticketNumber" DROP DEFAULT;

-- PASO 2: Cambiar el tipo de dato de INTEGER a VARCHAR(24)
-- Nota: Los valores numéricos existentes se convertirán a string automáticamente
ALTER TABLE "Ticket" ALTER COLUMN "ticketNumber" SET DATA TYPE VARCHAR(24);

-- PASO 3: Establecer el nuevo default (función de generación)
ALTER TABLE "Ticket" ALTER COLUMN "ticketNumber" SET DEFAULT generate_ticket_number();

-- PASO 4: Eliminar la secuencia autoincrement antigua
DROP SEQUENCE IF EXISTS "Ticket_ticketNumber_seq";

-- ===============================================================================
-- NOTAS POST-MIGRACIÓN
-- ===============================================================================
-- 1. Los tickets nuevos tendrán formato: TYYMMDD-XXXXXX-CC
-- 2. Los tickets existentes mantendrán su número original convertido a string
-- 3. La columna ticketNumber sigue siendo UNIQUE para prevenir duplicados
-- 4. El índice UNIQUE se mantiene automáticamente
