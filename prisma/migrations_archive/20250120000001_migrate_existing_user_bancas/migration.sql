-- ============================================================
-- MIGRACIÓN DE DATOS: Migrar usuarios existentes a UserBanca
-- ============================================================

-- Paso 1: Migrar usuarios ADMIN/VENTANA con bancaId directo (si existe campo bancaId en User)
-- Nota: Este paso se ejecuta solo si existe el campo bancaId en User
-- Si no existe, este paso se omite sin error

-- Paso 2: Migrar usuarios VENTANA/VENDEDOR a través de ventanaId
INSERT INTO "UserBanca" ("userId", "bancaId", "isDefault", "createdAt", "updatedAt")
SELECT DISTINCT
  u."id" as "userId",
  v."bancaId" as "bancaId",
  true as "isDefault",
  NOW() as "createdAt",
  NOW() as "updatedAt"
FROM "User" u
INNER JOIN "Ventana" v ON u."ventanaId" = v."id"
WHERE v."bancaId" IS NOT NULL
  AND u."role" IN ('ADMIN', 'VENTANA', 'VENDEDOR')
  AND NOT EXISTS (
    SELECT 1 FROM "UserBanca" ub 
    WHERE ub."userId" = u."id" 
    AND ub."bancaId" = v."bancaId"
  );

-- Paso 3: Verificar que cada usuario ADMIN tenga al menos una banca por defecto
-- Si un usuario tiene múltiples bancas pero ninguna marcada como default,
-- marcar la primera como default
UPDATE "UserBanca" ub1
SET "isDefault" = true
WHERE ub1."id" IN (
  SELECT ub2."id"
  FROM "UserBanca" ub2
  WHERE ub2."userId" IN (
    SELECT u."id"
    FROM "User" u
    WHERE u."role" = 'ADMIN'
      AND EXISTS (
        SELECT 1 FROM "UserBanca" ub3
        WHERE ub3."userId" = u."id"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "UserBanca" ub4
        WHERE ub4."userId" = u."id"
        AND ub4."isDefault" = true
      )
  )
  ORDER BY ub2."createdAt" ASC
  LIMIT (
    SELECT COUNT(DISTINCT ub2."userId")
    FROM "UserBanca" ub2
    WHERE ub2."userId" IN (
      SELECT u."id"
      FROM "User" u
      WHERE u."role" = 'ADMIN'
        AND EXISTS (
          SELECT 1 FROM "UserBanca" ub3
          WHERE ub3."userId" = u."id"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "UserBanca" ub4
          WHERE ub4."userId" = u."id"
          AND ub4."isDefault" = true
        )
    )
  )
);

-- Paso 4: Asegurar que cada usuario ADMIN tenga exactamente una banca por defecto
-- Si hay múltiples defaults, dejar solo el más antiguo
DO $$
DECLARE
  user_record RECORD;
  default_count INTEGER;
BEGIN
  FOR user_record IN 
    SELECT DISTINCT "userId"
    FROM "UserBanca"
    WHERE "userId" IN (SELECT "id" FROM "User" WHERE "role" = 'ADMIN')
  LOOP
    SELECT COUNT(*) INTO default_count
    FROM "UserBanca"
    WHERE "userId" = user_record."userId"
      AND "isDefault" = true;
    
    IF default_count > 1 THEN
      -- Si hay múltiples defaults, dejar solo el más antiguo
      UPDATE "UserBanca"
      SET "isDefault" = false
      WHERE "userId" = user_record."userId"
        AND "isDefault" = true
        AND "id" NOT IN (
          SELECT "id" FROM "UserBanca"
          WHERE "userId" = user_record."userId"
            AND "isDefault" = true
          ORDER BY "createdAt" ASC
          LIMIT 1
        );
    ELSIF default_count = 0 THEN
      -- Si no hay default, marcar la primera como default
      UPDATE "UserBanca"
      SET "isDefault" = true
      WHERE "id" = (
        SELECT "id" FROM "UserBanca"
        WHERE "userId" = user_record."userId"
        ORDER BY "createdAt" ASC
        LIMIT 1
      );
    END IF;
  END LOOP;
END $$;

