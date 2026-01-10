-- MIGRACIÓN: Agregar campos platform y appVersion a User
-- Esta migración agrega dos campos opcionales para rastrear la plataforma y versión de la app de cada usuario
-- Campos:
--   - platform: String opcional ('web' | 'android' | 'ios')
--   - appVersion: String opcional, máx 50 caracteres (ej: '2.0.7')

-- AlterTable: Agregar campos platform y appVersion
-- SEGURO: Campos opcionales (NULL permitido), no afecta datos existentes
ALTER TABLE "User"
ADD COLUMN "platform" TEXT,
ADD COLUMN "appVersion" VARCHAR(50);

-- CreateIndex: Índice opcional para facilitar búsquedas por plataforma
-- SEGURO: Solo crea índice, no afecta datos
CREATE INDEX "User_platform_idx" ON "User"("platform");

-- Comentarios sobre los campos:
-- - platform: Se actualiza en cada login si el cliente envía el campo
-- - appVersion: Se actualiza en cada login si el cliente envía el campo
-- - Ambos campos son opcionales para mantener retrocompatibilidad con versiones antiguas del frontend
