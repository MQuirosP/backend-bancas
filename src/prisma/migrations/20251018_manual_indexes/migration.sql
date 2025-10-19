-- Tus índices que ya existen en Supabase. Los declaramos aquí para que el historial coincida.
-- Nota: usamos IF NOT EXISTS por si alguien llega a ejecutar esto accidentalmente.

-- Loteria
CREATE INDEX IF NOT EXISTS "Loteria_name_idx" ON "Loteria"("name");

-- Sorteo
CREATE INDEX IF NOT EXISTS "Sorteo_name_idx" ON "Sorteo"("name");
CREATE INDEX IF NOT EXISTS "Sorteo_winningNumber_idx" ON "Sorteo"("winningNumber");

-- User
CREATE INDEX IF NOT EXISTS "User_code_idx" ON "User"("code");
CREATE INDEX IF NOT EXISTS "User_email_idx" ON "User"("email");
CREATE INDEX IF NOT EXISTS "User_name_idx" ON "User"("name");
CREATE INDEX IF NOT EXISTS "User_username_idx" ON "User"("username");

-- Ventana
CREATE INDEX IF NOT EXISTS "Ventana_code_idx" ON "Ventana"("code");
CREATE INDEX IF NOT EXISTS "Ventana_email_idx" ON "Ventana"("email");
CREATE INDEX IF NOT EXISTS "Ventana_name_idx" ON "Ventana"("name");
CREATE INDEX IF NOT EXISTS "Ventana_phone_idx" ON "Ventana"("phone");
