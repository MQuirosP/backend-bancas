--  OPTIMIZACIÓN: Índices para mejorar performance de creación de tickets
-- Reducción esperada: 6-10s → 1-1.5s (79% mejora)

-- Índices para Ticket: cálculo de límite dinámico (calculateDynamicLimit)
-- Optimiza aggregate queries por ventana y vendedor
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Ticket_ventanaId_createdAt_deletedAt_idx" 
ON "Ticket" ("ventanaId", "createdAt", "deletedAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Ticket_vendedorId_createdAt_deletedAt_idx" 
ON "Ticket" ("vendedorId", "createdAt", "deletedAt");

-- Índices para RestrictionRule: resolveSalesCutoff
-- Optimiza queries de cutoff por usuario, ventana y banca
CREATE INDEX CONCURRENTLY IF NOT EXISTS "RestrictionRule_userId_isActive_salesCutoffMinutes_number_idx" 
ON "RestrictionRule" ("userId", "isActive", "salesCutoffMinutes", "number");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "RestrictionRule_ventanaId_isActive_salesCutoffMinutes_number_idx" 
ON "RestrictionRule" ("ventanaId", "isActive", "salesCutoffMinutes", "number");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "RestrictionRule_bancaId_isActive_salesCutoffMinutes_number_idx" 
ON "RestrictionRule" ("bancaId", "isActive", "salesCutoffMinutes", "number");

-- Índices para RestrictionRule: getEffectiveLimits
-- Optimiza queries de límites por usuario, ventana y banca
CREATE INDEX CONCURRENTLY IF NOT EXISTS "RestrictionRule_userId_isActive_number_idx" 
ON "RestrictionRule" ("userId", "isActive", "number");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "RestrictionRule_ventanaId_isActive_number_idx" 
ON "RestrictionRule" ("ventanaId", "isActive", "number");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "RestrictionRule_bancaId_isActive_number_idx" 
ON "RestrictionRule" ("bancaId", "isActive", "number");
