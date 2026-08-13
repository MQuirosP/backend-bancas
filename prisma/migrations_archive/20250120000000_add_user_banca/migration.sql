-- ============================================================
-- MIGRACIÓN: Tabla UserBanca (Muchos-a-Muchos)
-- ============================================================
-- Descripción: Permite que un usuario ADMIN tenga acceso a múltiples bancas
-- Fecha: 2025-01-20
-- Autor: Sistema

-- Crear tabla de relación muchos-a-muchos
CREATE TABLE IF NOT EXISTS "UserBanca" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "bancaId" UUID NOT NULL,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  -- Constraints
  CONSTRAINT "UserBanca_userId_fkey" 
    FOREIGN KEY ("userId") 
    REFERENCES "User"("id") 
    ON DELETE CASCADE 
    ON UPDATE CASCADE,
    
  CONSTRAINT "UserBanca_bancaId_fkey" 
    FOREIGN KEY ("bancaId") 
    REFERENCES "Banca"("id") 
    ON DELETE CASCADE 
    ON UPDATE CASCADE,
    
  -- Un usuario no puede tener la misma banca duplicada
  CONSTRAINT "UserBanca_userId_bancaId_unique" 
    UNIQUE ("userId", "bancaId")
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS "UserBanca_userId_idx" ON "UserBanca"("userId");
CREATE INDEX IF NOT EXISTS "UserBanca_bancaId_idx" ON "UserBanca"("bancaId");
CREATE INDEX IF NOT EXISTS "UserBanca_isDefault_idx" ON "UserBanca"("userId", "isDefault") WHERE "isDefault" = true;

-- Comentarios
COMMENT ON TABLE "UserBanca" IS 'Relación muchos-a-muchos entre usuarios ADMIN y bancas';
COMMENT ON COLUMN "UserBanca"."isDefault" IS 'Indica si esta es la banca por defecto del usuario';

