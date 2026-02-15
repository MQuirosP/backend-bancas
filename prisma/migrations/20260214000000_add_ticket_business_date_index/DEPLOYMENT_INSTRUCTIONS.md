# Migracion: Indice en Ticket.businessDate

## Resumen

Crea un indice en la columna `businessDate` de la tabla `Ticket`.
Este indice es necesario porque los cambios de codigo eliminan `COALESCE(businessDate, ...)` y ahora filtran directamente por `businessDate`, lo cual requiere un indice para evitar sequential scans.

## Seguridad

- Solo crea un indice, NO modifica datos ni columnas
- Usa `CONCURRENTLY` para no bloquear la tabla durante la creacion
- Es completamente reversible
- No afecta lecturas ni escrituras existentes

## IMPORTANTE: No usar migrate deploy directamente

`CREATE INDEX CONCURRENTLY` **no puede ejecutarse dentro de una transaccion**, y `prisma migrate deploy` ejecuta cada migracion dentro de una transaccion. Por eso se debe ejecutar manualmente.

## Pasos de Aplicacion

### Paso 1: Ejecutar SQL en Supabase

1. Ir a **Supabase Dashboard -> SQL Editor**
2. Copiar y ejecutar:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Ticket_businessDate_idx"
  ON "Ticket" ("businessDate");
```

3. Verificar que no hay errores

### Paso 2: Verificar Indice

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'Ticket'
AND indexname = 'Ticket_businessDate_idx';
-- Esperado: 1 fila
```

### Paso 3: Marcar Migracion como Aplicada

```bash
npx prisma migrate resolve --applied 20260214000000_add_ticket_business_date_index
```

### Paso 4: Verificar Estado

```bash
npm run migrate:status
```

## Rollback (si es necesario)

```sql
-- Ejecutar en Supabase SQL Editor:
DROP INDEX CONCURRENTLY IF EXISTS "Ticket_businessDate_idx";
```

```bash
npx prisma migrate resolve --rolled-back 20260214000000_add_ticket_business_date_index
```
