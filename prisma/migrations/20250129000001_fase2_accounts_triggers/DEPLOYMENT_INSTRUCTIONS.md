# Instrucciones de Deployment: Fase 2 - Triggers de Automatización

## 📋 Resumen

Esta migración crea un trigger que actualiza automáticamente `AccountStatement` cuando se insertan, actualizan o eliminan registros en `AccountPayment`.

## ✅ Componentes Creados

1. **Función**: `update_account_statement_on_payment_change()`
2. **Trigger**: `account_payment_trigger` en la tabla `AccountPayment`

## 🚀 Pasos de Deployment

### 1. Pre-Deployment Checklist

- [ ] **CRÍTICO**: Verificar que la Fase 1 está aplicada (funciones de agregación)
- [ ] Backup de la base de datos
- [ ] Verificar que no hay transacciones activas críticas
- [ ] Notificar al equipo sobre el mantenimiento
- [ ] Preparar script de rollback

### 2. Aplicar Migración

```bash
# Opción A: Usando Prisma Migrate (recomendado)
npx prisma migrate deploy

# Opción B: Aplicar manualmente
psql -U <usuario> -d <database> -f prisma/migrations/20250129000001_fase2_accounts_triggers/migration.sql
```

### 3. Verificar Trigger

```sql
-- Verificar que el trigger existe
SELECT tgname, tgrelid::regclass, tgenabled
FROM pg_trigger
WHERE tgname = 'account_payment_trigger';

-- Verificar que la función existe
SELECT proname, prosrc 
FROM pg_proc 
WHERE proname = 'update_account_statement_on_payment_change';

-- Probar trigger (insertar un pago de prueba y verificar que se actualiza el statement)
-- NOTA: Revertir el pago de prueba después
```

### 4. Validar Consistencia

```sql
-- Verificar que los statements están actualizados correctamente
-- Comparar totalPaid, totalCollected, remainingBalance calculados vs. reales

SELECT 
    as.id,
    as."totalPaid" as statement_total_paid,
    as."totalCollected" as statement_total_collected,
    as."remainingBalance" as statement_remaining_balance,
    (SELECT COALESCE(SUM(CASE WHEN type = 'payment' AND NOT "isReversed" THEN amount ELSE 0 END), 0) 
     FROM "AccountPayment" WHERE "accountStatementId" = as.id) as calculated_total_paid,
    (SELECT COALESCE(SUM(CASE WHEN type = 'collection' AND NOT "isReversed" THEN amount ELSE 0 END), 0) 
     FROM "AccountPayment" WHERE "accountStatementId" = as.id) as calculated_total_collected
FROM "AccountStatement" as
WHERE as."totalPaid" != (
    SELECT COALESCE(SUM(CASE WHEN type = 'payment' AND NOT "isReversed" THEN amount ELSE 0 END), 0) 
    FROM "AccountPayment" WHERE "accountStatementId" = as.id
)
OR as."totalCollected" != (
    SELECT COALESCE(SUM(CASE WHEN type = 'collection' AND NOT "isReversed" THEN amount ELSE 0 END), 0) 
    FROM "AccountPayment" WHERE "accountStatementId" = as.id
)
LIMIT 10;
```

Si esta query retorna filas, hay inconsistencias que deben corregirse antes de continuar.

### 5. Monitoreo Post-Deployment

- [ ] Verificar logs de aplicación (buscar errores relacionados con triggers)
- [ ] Monitorear rendimiento (el trigger se ejecuta en cada cambio de AccountPayment)
- [ ] Validar que los statements se actualizan automáticamente
- [ ] Probar registro y reversión de pagos/cobros
- [ ] Verificar que `isSettled` y `canEdit` se calculan correctamente

## ⚠️ Rollback

Si es necesario revertir la migración:

```bash
# Aplicar script de rollback
psql -U <usuario> -d <database> -f prisma/migrations/20250129000001_fase2_accounts_triggers/rollback.sql
```

**IMPORTANTE**: Después de revertir el trigger, el código backend debe actualizar manualmente los statements. Asegurar que el código está desplegado antes de revertir, o revertir el código también.

## 📊 Métricas de Éxito

- 100% de AccountStatements actualizados automáticamente
- Sin inconsistencias entre totales calculados y reales
- Sin errores en logs relacionados con triggers
- Tiempo de respuesta de registro/reversión de pagos similar o mejor

## 🔍 Troubleshooting

### Error: "function get_account_payment_totals does not exist"
- **Causa**: La Fase 1 no está aplicada
- **Solución**: Aplicar la Fase 1 primero, o el trigger calculará totales directamente (menos eficiente)

### Error: "trigger already exists"
- **Causa**: El trigger ya fue creado
- **Solución**: Eliminar el trigger existente primero o usar `CREATE OR REPLACE`

### Inconsistencias en totales
- **Causa**: Statements creados antes del trigger o datos corruptos
- **Solución**: Ejecutar script de corrección de inconsistencias (ver sección de validación)

### Degradación de rendimiento
- **Causa**: El trigger se ejecuta en cada cambio de AccountPayment
- **Solución**: 
  - Verificar índices en AccountPayment
  - Considerar optimizar la función del trigger
  - Monitorear carga de CPU/memoria

## 🔄 Script de Corrección de Inconsistencias

Si se encuentran inconsistencias después del deployment:

```sql
-- Script para corregir inconsistencias (ejecutar con cuidado)
DO $$
DECLARE
    stmt RECORD;
    v_total_paid NUMERIC;
    v_total_collected NUMERIC;
    v_remaining_balance NUMERIC;
    v_is_settled BOOLEAN;
BEGIN
    FOR stmt IN 
        SELECT id, balance, "ticketCount"
        FROM "AccountStatement"
    LOOP
        -- Calcular totales reales
        SELECT
            COALESCE(SUM(CASE WHEN type = 'payment' AND NOT "isReversed" THEN amount ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN type = 'collection' AND NOT "isReversed" THEN amount ELSE 0 END), 0)
        INTO v_total_paid, v_total_collected
        FROM "AccountPayment"
        WHERE "accountStatementId" = stmt.id;
        
        -- Calcular remainingBalance
        v_remaining_balance := stmt.balance - v_total_collected + v_total_paid;
        
        -- Calcular isSettled
        v_is_settled := (
            stmt."ticketCount" > 0
            AND ABS(v_remaining_balance) < 0.01
            AND (v_total_paid > 0 OR v_total_collected > 0)
        );
        
        -- Actualizar statement
        UPDATE "AccountStatement"
        SET
            "totalPaid" = v_total_paid,
            "totalCollected" = v_total_collected,
            "remainingBalance" = v_remaining_balance,
            "isSettled" = v_is_settled,
            "canEdit" = NOT v_is_settled,
            "updatedAt" = NOW()
        WHERE id = stmt.id;
    END LOOP;
END $$;
```


