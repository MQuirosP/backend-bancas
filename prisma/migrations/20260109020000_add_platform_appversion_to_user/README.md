# Migración: Agregar platform y appVersion a User

## Descripción
Esta migración agrega dos campos opcionales al modelo `User` para rastrear la plataforma y versión de la aplicación de cada usuario.

## Campos agregados
- `platform` (String, opcional): Indica la plataforma del cliente ('web' | 'android' | 'ios')
- `appVersion` (String, opcional, max 50 caracteres): Versión de la aplicación (ej: '2.0.7')

## Aplicación

### Opción 1: Aplicación manual (RECOMENDADO para producción)
```bash
# 1. Conectarse a la base de datos de producción (Supabase)
# 2. Ejecutar el archivo migration.sql manualmente

# 3. Marcar la migración como aplicada
npx prisma migrate resolve --applied 20260109020000_add_platform_appversion_to_user
```

### Opción 2: Usando prisma migrate deploy (si está configurado)
```bash
npx prisma migrate deploy
```

## Rollback
Si necesitas revertir esta migración, ejecuta:
```bash
# 1. Ejecutar ROLLBACK.sql manualmente en la base de datos
# 2. Marcar como revertida
npx prisma migrate resolve --rolled-back 20260109020000_add_platform_appversion_to_user
```

## Verificación
Después de aplicar, verifica que los campos existan:
```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'User'
AND column_name IN ('platform', 'appVersion');
```

## Seguridad
✅ Esta migración es 100% segura:
- Solo agrega campos opcionales (NULL permitido)
- No modifica datos existentes
- No elimina ni renombra campos
- Es completamente reversible
