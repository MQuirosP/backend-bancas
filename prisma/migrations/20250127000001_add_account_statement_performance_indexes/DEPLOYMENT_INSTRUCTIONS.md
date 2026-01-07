# Instrucciones de Despliegue: Índices de Rendimiento para Estados de Cuenta

## ️ IMPORTANTE: No usar `migrate deploy`

**Razón:** `CREATE INDEX CONCURRENTLY` no puede ejecutarse dentro de una transacción, y `prisma migrate deploy` ejecuta las migraciones en transacciones.

##  Solución: Ejecutar SQL Manualmente

### Paso 1: Ejecutar SQL en Supabase

1. Ir a **Supabase Dashboard > SQL Editor**
2. Abrir el archivo: `prisma/migrations/20250127000001_add_account_statement_performance_indexes/migration.sql`
3. Copiar **TODO el contenido** (desde la primera línea `CREATE INDEX CONCURRENTLY`)
4. Pegar en SQL Editor
5. Click en **"Run"** (️)
6. **ESPERAR** a que complete (puede tomar 5-15 minutos, **NO interrumpir**)

### Paso 2: Verificar que los Índices se Crearon

Ejecutar en Supabase SQL Editor:

```sql
-- Verificar que todos los índices se crearon
SELECT indexname, tablename
FROM pg_indexes
WHERE indexname IN (
  'idx_account_statements_date_settled_dimension',
  'idx_account_statements_month_settled',
  'idx_tickets_business_date_status_optimized',
  'idx_tickets_today_evaluated',
  'idx_tickets_ventana_vendedor_date',
  'idx_jugada_ticket_id_deleted',
  'idx_jugada_commissions_payout'
)
ORDER BY tablename, indexname;
-- Esperado: 7 resultados
```

### Paso 3: Marcar Migración como Aplicada

Después de verificar que los índices se crearon correctamente, ejecutar:

```bash
npx prisma migrate resolve --applied 20250127000001_add_account_statement_performance_indexes
```

Esto marca la migración como aplicada sin intentar ejecutarla nuevamente.

##  Monitoreo Durante Ejecución

Si quieres ver el progreso de la creación de índices:

```sql
-- Ver progreso de creación de índices
SELECT
  phase,
  round(100.0 * blocks_done / nullif(blocks_total, 0), 2) AS "% completado",
  index_relid::regclass AS "índice",
  relid::regclass AS "tabla"
FROM pg_stat_progress_create_index;
```

##  Verificación Post-Despliegue

1. Verificar que los 7 índices aparecen en la query de verificación
2. Probar endpoint: `GET /api/v1/accounts/statement?date=today`
3. Verificar que el tiempo de respuesta es <1s
4. Verificar logs de aplicación (no deben haber errores)

##  Si Algo Sale Mal

Si algún índice falla:

1. Verificar si hay índices inválidos:
```sql
SELECT indexname FROM pg_indexes WHERE indexname LIKE '%_ccold';
```

2. Eliminar índice inválido si existe:
```sql
DROP INDEX CONCURRENTLY IF EXISTS nombre_indice_ccold;
```

3. Reintentar creación del índice específico desde el archivo migration.sql

4. Si todo falla, contactar al equipo de desarrollo

##  Notas

- Los índices se crean con `IF NOT EXISTS`, por lo que es seguro re-ejecutar
- `CREATE INDEX CONCURRENTLY` no bloquea las tablas durante la creación
- La aplicación seguirá funcionando normalmente durante el despliegue
- El rollback es seguro (solo elimina índices, no afecta datos)

