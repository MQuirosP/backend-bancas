# Instrucciones de Despliegue - Índices de Rendimiento Accounts (Prioridad 1)

## 📋 Resumen

Esta migración agrega índices críticos para optimizar el rendimiento del módulo de accounts:
- Índice en `Jugada.listeroCommissionAmount` (agregaciones de comisiones)
- Índice compuesto en `AccountPayment(date, ventanaId)` (búsquedas de movimientos)
- Índice compuesto en `AccountPayment(date, vendedorId)` (búsquedas de movimientos por vendedor)

## ⚠️ Seguridad

- ✅ **Segura para producción**: Usa `CREATE INDEX CONCURRENTLY` (no bloquea tablas)
- ✅ **Reversible**: Los índices se pueden eliminar sin pérdida de datos
- ✅ **Sin downtime**: No requiere ventana de mantenimiento

## 🚀 Pasos de Despliegue

### 1. Pre-verificación

```bash
# Verificar estado de migraciones
npx prisma migrate status

# Verificar que no hay migraciones pendientes
# Debe mostrar: "Database schema is up to date"
```

### 2. Ejecutar Migración

**Opción A: Usando Prisma Migrate (Recomendado)**
```bash
npx prisma migrate deploy
```

**Opción B: Ejecutar SQL directamente (Si Prisma falla)**
1. Abrir editor SQL de Supabase/PostgreSQL
2. Copiar contenido de `migration.sql`
3. Ejecutar el script completo
4. Verificar que no hay errores

### 3. Verificación Post-Migración

```sql
-- Verificar que los índices se crearon correctamente
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE indexname IN (
  'idx_jugada_listero_commission_amount',
  'idx_account_payment_date_ventana',
  'idx_account_payment_date_vendedor'
)
ORDER BY tablename, indexname;
```

**Debe mostrar 3 índices creados.**

### 4. Pruebas Funcionales

1. **Probar endpoint de accounts:**
   ```bash
   GET /api/v1/accounts/statement?month=2025-01&dimension=ventana
   ```

2. **Verificar logs:**
   - No deben aparecer errores relacionados con índices
   - Los tiempos de respuesta deben mejorar (30-50% más rápido)

3. **Monitorear rendimiento:**
   - Comparar tiempos antes/después de la migración
   - Verificar que las queries usan los nuevos índices

## 🔄 Rollback (Si es Necesario)

Si necesitas revertir la migración:

```sql
DROP INDEX CONCURRENTLY IF EXISTS "idx_jugada_listero_commission_amount";
DROP INDEX CONCURRENTLY IF EXISTS "idx_account_payment_date_ventana";
DROP INDEX CONCURRENTLY IF EXISTS "idx_account_payment_date_vendedor";
```

**Nota**: El rollback es seguro y no afecta los datos, solo el rendimiento.

## 📊 Impacto Esperado

- **Tiempo de respuesta**: 30-50% mejora en queries de accounts
- **Agregaciones de comisiones**: 40-50% más rápidas
- **Búsquedas de movimientos**: 50-60% más rápidas

## ⏱️ Tiempo Estimado

- **Creación de índices**: 2-10 minutos (depende del tamaño de las tablas)
- **Downtime**: 0 minutos (CONCURRENTLY no bloquea)

## 🆘 Troubleshooting

### Error: "index already exists"
- **Causa**: El índice ya fue creado en una migración anterior
- **Solución**: Ignorar el error, el índice ya está presente

### Error: "relation does not exist"
- **Causa**: La tabla no existe o el nombre está mal escrito
- **Solución**: Verificar que las tablas `Jugada` y `AccountPayment` existen

### Índice tarda mucho en crearse
- **Causa**: Tabla muy grande
- **Solución**: Normal, puede tomar hasta 10-15 minutos. No interrumpir.

## 📝 Notas Adicionales

- Los índices se crean con `CONCURRENTLY` para evitar bloqueos
- Los índices parciales (con WHERE) son más eficientes y ocupan menos espacio
- Esta migración es parte de la **Prioridad 1** del plan de optimización de accounts

