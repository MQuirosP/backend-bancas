# Instrucciones de Deployment: Fase 1 - Funciones de Agregación

## 📋 Resumen

Esta migración crea funciones almacenadas PostgreSQL para optimizar las agregaciones de estados de cuenta, moviendo lógica del backend a la base de datos.

## ✅ Funciones Creadas

1. **`calculate_account_statement_aggregates()`**: Calcula agregaciones de tickets/jugadas por fecha y dimensión
2. **`get_account_payment_totals()`**: Calcula totales de pagos y cobros para un AccountStatement

## 🚀 Pasos de Deployment

### 1. Pre-Deployment Checklist

- [ ] Backup de la base de datos
- [ ] Verificar que no hay transacciones activas críticas
- [ ] Notificar al equipo sobre el mantenimiento

### 2. Aplicar Migración

```bash
# Opción A: Usando Prisma Migrate (recomendado)
npx prisma migrate deploy

# Opción B: Aplicar manualmente
psql -U <usuario> -d <database> -f prisma/migrations/20250129000000_fase1_accounts_aggregates_functions/migration.sql
```

### 3. Verificar Funciones

```sql
-- Verificar que las funciones existen
SELECT proname, prosrc 
FROM pg_proc 
WHERE proname IN ('calculate_account_statement_aggregates', 'get_account_payment_totals');

-- Probar función de agregados (ejemplo)
SELECT * FROM calculate_account_statement_aggregates(
    '2025-01-01'::date,
    '2025-01-31'::date,
    'banca'::text,
    NULL::uuid,
    NULL::uuid,
    NULL::uuid,
    false::boolean,
    1000::bigint,
    'DESC'::text
);

-- Probar función de totales (necesita un statement_id existente)
SELECT * FROM get_account_payment_totals('<statement_id>'::uuid);
```

### 4. Monitoreo Post-Deployment

- [ ] Verificar logs de aplicación (buscar errores relacionados con funciones SQL)
- [ ] Monitorear rendimiento de queries (tiempo de respuesta)
- [ ] Validar que los estados de cuenta se calculan correctamente
- [ ] Comparar resultados con versión anterior (si es posible)

## ⚠️ Rollback

Si es necesario revertir la migración:

```bash
# Aplicar script de rollback
psql -U <usuario> -d <database> -f prisma/migrations/20250129000000_fase1_accounts_aggregates_functions/rollback.sql
```

**Nota**: El código backend tiene fallback automático a queries directas si las funciones no existen, pero es recomendable revertir el código también si se revierte la migración.

## 📊 Métricas de Éxito

- Reducción de 30-40% en tiempo de query de estados de cuenta
- Sin errores en logs relacionados con funciones SQL
- Resultados idénticos a la versión anterior

## 🔍 Troubleshooting

### Error: "function does not exist"
- Verificar que la migración se aplicó correctamente
- Verificar permisos del usuario de la aplicación

### Error: "permission denied"
- Asegurar que el usuario de la aplicación tiene permisos EXECUTE en las funciones

### Resultados diferentes a versión anterior
- Comparar queries SQL generadas
- Verificar que los parámetros se pasan correctamente
- Revisar logs de la aplicación


