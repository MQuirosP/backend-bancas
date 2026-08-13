-- ROLLBACK: Revertir adición de campos platform y appVersion a User
-- Este script revierte la migración 20260109020000_add_platform_appversion_to_user

-- Eliminar índice
DROP INDEX IF EXISTS "User_platform_idx";

-- Eliminar columnas
ALTER TABLE "User"
DROP COLUMN IF EXISTS "platform",
DROP COLUMN IF EXISTS "appVersion";
