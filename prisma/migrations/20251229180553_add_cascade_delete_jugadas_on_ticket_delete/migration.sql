-- Migration: Agregar ON DELETE CASCADE a Jugada -> Ticket
-- ⚠️ IMPORTANTE: Este cambio permite que al eliminar un Ticket se eliminen automáticamente sus Jugadas relacionadas
-- Esto es necesario para poder eliminar tickets directamente desde el editor SQL de Supabase
--
-- IMPORTANTE: Esta migración debe aplicarse con cuidado en producción
-- Paso 1: Hacer backup de la base de datos
-- Paso 2: Ejecutar esta migración en ventana de mantenimiento si es necesario
-- Paso 3: Verificar que el comportamiento CASCADE es el esperado

-- Paso 1: Eliminar la constraint existente
ALTER TABLE "Jugada"
  DROP CONSTRAINT IF EXISTS "Jugada_ticketId_fkey";

-- Paso 2: Crear la nueva constraint con CASCADE
ALTER TABLE "Jugada"
  ADD CONSTRAINT "Jugada_ticketId_fkey"
  FOREIGN KEY ("ticketId")
  REFERENCES "Ticket"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

-- Verificación: Confirmar que la constraint se creó correctamente
-- SELECT con_name, conrelid::regclass, confrelid::regclass, confdeltype
-- FROM pg_constraint
-- WHERE conname = 'Jugada_ticketId_fkey';
-- confdeltype debería ser 'c' (CASCADE) en lugar de 'r' (RESTRICT)

