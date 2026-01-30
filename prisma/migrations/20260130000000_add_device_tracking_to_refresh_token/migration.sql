-- ============================================================================
-- MIGRACIÓN: Agregar tracking de dispositivos a RefreshToken
-- SEGURIDAD: Solo agrega columnas opcionales (NULL permitido) - NO destructivo
-- ============================================================================

-- 1. Agregar nuevas columnas (todas opcionales)
ALTER TABLE "RefreshToken"
  ADD COLUMN IF NOT EXISTS "deviceId" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "deviceName" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "userAgent" TEXT,
  ADD COLUMN IF NOT EXISTS "ipAddress" VARCHAR(45),
  ADD COLUMN IF NOT EXISTS "lastUsedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "revokedReason" VARCHAR(50);

-- 2. Índice para búsquedas por usuario (CRÍTICO - no existía)
CREATE INDEX IF NOT EXISTS "idx_refresh_token_user_id"
  ON "RefreshToken"("userId");

-- 3. Índice para búsquedas por usuario + dispositivo
CREATE INDEX IF NOT EXISTS "idx_refresh_token_user_device"
  ON "RefreshToken"("userId", "deviceId")
  WHERE "deviceId" IS NOT NULL;
