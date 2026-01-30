-- ============================================================================
-- ROLLBACK: Revertir tracking de dispositivos
-- ============================================================================

-- Eliminar índices
DROP INDEX IF EXISTS "idx_refresh_token_user_id";
DROP INDEX IF EXISTS "idx_refresh_token_user_device";

-- Eliminar columnas
ALTER TABLE "RefreshToken"
  DROP COLUMN IF EXISTS "deviceId",
  DROP COLUMN IF EXISTS "deviceName",
  DROP COLUMN IF EXISTS "userAgent",
  DROP COLUMN IF EXISTS "ipAddress",
  DROP COLUMN IF EXISTS "lastUsedAt",
  DROP COLUMN IF EXISTS "revokedAt",
  DROP COLUMN IF EXISTS "revokedReason";
