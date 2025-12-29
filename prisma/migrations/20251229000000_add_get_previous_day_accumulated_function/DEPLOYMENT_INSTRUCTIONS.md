# Instrucciones de Despliegue: get_previous_day_accumulated

## ✅ Migración Segura

Esta migración es **100% segura** porque:
- Solo crea una función PostgreSQL (no modifica datos existentes)
- Usa `CREATE OR REPLACE` (idempotente)
- No afecta tablas ni datos existentes
- Puede ejecutarse múltiples veces sin problemas

## Pasos de Despliegue

### 1. Aplicar la migración manualmente

```bash
# Opción A: Usar psql directamente
psql $DATABASE_URL -f prisma/migrations/20251229000000_add_get_previous_day_accumulated_function/migration.sql

# Opción B: Usar el script de aplicación
npm run apply:get-previous-day-accumulated
```

### 2. Verificar que la función se creó correctamente

```sql
-- Verificar que la función existe
SELECT proname, prosrc 
FROM pg_proc 
WHERE proname = 'get_previous_day_accumulated';

-- Probar la función
SELECT get_previous_day_accumulated(
    '2025-12-28'::DATE,
    'banca',
    NULL,
    NULL,
    NULL
);
```

### 3. Marcar la migración como aplicada en Prisma

```bash
# Marcar como aplicada sin ejecutarla (ya la aplicamos manualmente)
npx dotenv-cli -e .env.local -- prisma migrate resolve --applied 20251229000000_add_get_previous_day_accumulated_function
```

## Rollback (si es necesario)

Si necesitas revertir la función:

```sql
DROP FUNCTION IF EXISTS get_previous_day_accumulated(DATE, TEXT, UUID, UUID, UUID);
```

## Testing

Después de aplicar, verificar que:
1. La función existe en la BD
2. Retorna valores correctos para diferentes dimensiones
3. Retorna 0 cuando no hay datos previos
4. El backend puede llamarla correctamente

