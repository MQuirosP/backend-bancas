-- Migración C: Eliminar TicketCounter (ya no se utiliza)
-- =========================================================================
-- Esta migración elimina la tabla TicketCounter que ya no es necesaria
-- porque la generación de ticket numbers ahora se hace con la secuencia
-- global ticket_no_seq y la función generate_ticket_number().
--
-- ADVERTENCIA: Esta operación elimina todos los datos de TicketCounter.
-- Si existiera alguna dependencia activa, esta migración fallaría.
-- =========================================================================

-- Eliminar tabla TicketCounter
DROP TABLE IF EXISTS "TicketCounter";

-- =========================================================================
-- NOTAS POST-MIGRACIÓN
-- =========================================================================
-- 1. La tabla TicketCounter ya no existe
-- 2. La generación de ticket numbers es ahora completamente manejada por:
--    - Secuencia: ticket_no_seq
--    - Función: generate_ticket_number()
-- 3. No hay pérdida de funcionalidad; el sistema anterior no se utilizaba
