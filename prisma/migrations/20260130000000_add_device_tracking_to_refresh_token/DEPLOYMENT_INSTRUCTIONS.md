# Migración: Device Tracking para RefreshToken

## Resumen

Agrega campos para tracking de dispositivos en la tabla `RefreshToken`:
- `deviceId` - UUID del dispositivo
- `deviceName` - Nombre legible del dispositivo
- `userAgent` - User-Agent del navegador/app
- `ipAddress` - IP del cliente
- `lastUsedAt` - Última vez que se usó el token
- `revokedAt` - Cuándo se revocó
- `revokedReason` - Motivo de revocación

## Seguridad

✅ **Esta migración es 100% segura:**
- Solo agrega columnas opcionales (NULL permitido)
- No modifica datos existentes
- No elimina ni renombra columnas
- Es completamente reversible

## Pasos de Aplicación

### Paso 1: Ejecutar SQL en Supabase

1. Ir a **Supabase Dashboard → SQL Editor**
2. Copiar el contenido de `migration.sql`
3. Ejecutar (Click en "Run")
4. Verificar que no hay errores

### Paso 2: Verificar Columnas

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'RefreshToken'
AND column_name IN ('deviceId', 'deviceName', 'userAgent', 'ipAddress', 'lastUsedAt', 'revokedAt', 'revokedReason')
ORDER BY column_name;
-- Esperado: 7 filas
```

### Paso 3: Verificar Índices

```sql
SELECT indexname FROM pg_indexes
WHERE tablename = 'RefreshToken'
AND indexname IN ('idx_refresh_token_user_id', 'idx_refresh_token_user_device');
-- Esperado: 2 filas
```

### Paso 4: Marcar Migración como Aplicada

```bash
npx prisma migrate resolve --applied 20260130000000_add_device_tracking_to_refresh_token
```

### Paso 5: Verificar Estado

```bash
npm run migrate:status
```

## Rollback (si es necesario)

```sql
-- Ejecutar ROLLBACK.sql en Supabase
```

```bash
npx prisma migrate resolve --rolled-back 20260130000000_add_device_tracking_to_refresh_token
```
