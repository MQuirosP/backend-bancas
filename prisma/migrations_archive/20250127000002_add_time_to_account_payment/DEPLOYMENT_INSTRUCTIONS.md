# Instrucciones de Deployment: Agregar Campo `time` a AccountPayment

**Migración**: `20250127000002_add_time_to_account_payment`  
**Fecha**: 2025-01-27  
**Prioridad**: MEDIA  
**Tiempo estimado**: < 1 minuto

---

##  Resumen

Esta migración agrega el campo `time` (VARCHAR(5)) opcional a la tabla `AccountPayment` para permitir que los usuarios especifiquen la hora del movimiento (pago/cobro). Esto permite intercalar correctamente los movimientos con los sorteos en el desglose día/sorteo.

---

##  Cambios

### Schema Prisma
- **Tabla**: `AccountPayment`
- **Campo nuevo**: `time String? @db.VarChar(5)` (opcional)
- **Formato**: `HH:MM` (24 horas, ej: "14:30")
- **Nullable**: Sí (opcional para compatibilidad con datos existentes)

### SQL
```sql
ALTER TABLE "AccountPayment" ADD COLUMN "time" VARCHAR(5);
```

---

##  Deployment en Producción

### Opción 1: Usar Prisma Migrate Deploy (Recomendado)

```bash
# Desde el directorio del proyecto
npx prisma migrate deploy
```

**Ventajas**:
- Prisma aplica solo esta migración
- Verifica que la migración no haya sido aplicada previamente
- Registra la migración en `_prisma_migrations`

**Nota**: Esta migración es simple (solo ALTER TABLE ADD COLUMN) y es segura en producción.

---

### Opción 2: Ejecutar SQL Manualmente (Si hay problemas con migrate deploy)

1. **Conectar a Supabase SQL Editor**

2. **Ejecutar el SQL**:
```sql
ALTER TABLE "AccountPayment" ADD COLUMN "time" VARCHAR(5);
```

3. **Verificar**:
```sql
-- Verificar que la columna se agregó correctamente
SELECT column_name, data_type, character_maximum_length, is_nullable
FROM information_schema.columns
WHERE table_name = 'AccountPayment' AND column_name = 'time';
```

4. **Marcar migración como aplicada** (si usaste SQL manual):
```bash
npx prisma migrate resolve --applied 20250127000002_add_time_to_account_payment
```

---

##  Backfill Opcional: Extraer Hora de Registros Existentes

### ¿Por qué hacer backfill?

Los registros antiguos tienen `time = NULL` y actualmente usan `createdAt` para ordenarse en el desglose día/sorteo. Si queremos que todos los registros tengan hora explícita (para consistencia y mejor ordenamiento), podemos extraer la hora de `createdAt` y guardarla en `time`.

**Nota**: Este paso es **opcional**. Los registros funcionan correctamente con `time = NULL` (usan `createdAt` automáticamente).

### Ejecutar Backfill

**1. Dry run (recomendado primero)**:
```bash
npx dotenv-cli -e .env.local -- ts-node src/scripts/backfill-account-payment-time.ts --dry-run
```

Esto mostrará qué registros se actualizarían sin hacer cambios.

**2. Ejecutar backfill completo**:
```bash
npx dotenv-cli -e .env.local -- ts-node src/scripts/backfill-account-payment-time.ts
```

**3. Ejecutar con límite (para probar primero)**:
```bash
# Procesar solo los primeros 100 registros
npx dotenv-cli -e .env.local -- ts-node src/scripts/backfill-account-payment-time.ts --limit 100
```

**4. Ejecutar con batch size personalizado**:
```bash
# Procesar en batches de 500 (default: 1000)
npx dotenv-cli -e .env.local -- ts-node src/scripts/backfill-account-payment-time.ts --batch-size 500
```

**Nota**: Este script se ejecuta solo una vez. No está en `package.json` porque es un mantenimiento puntual.

### ¿Qué hace el backfill?

1. Busca todos los `AccountPayment` con `time = NULL`
2. Extrae la hora de `createdAt` (convertida a CR)
3. Guarda la hora en formato `HH:MM` en el campo `time`
4. Procesa en batches para evitar sobrecarga

**Ejemplo**:
- `createdAt`: `2025-01-27T20:30:00.000Z` (UTC)
- Hora en CR: `14:30` (20:30 UTC - 6 horas = 14:30 CR)
- `time`: `"14:30"`

---

##  Verificación Post-Deployment

### 1. Verificar que la columna existe
```sql
SELECT column_name, data_type, character_maximum_length, is_nullable
FROM information_schema.columns
WHERE table_name = 'AccountPayment' AND column_name = 'time';
```

**Resultado esperado**:
- `column_name`: `time`
- `data_type`: `character varying`
- `character_maximum_length`: `5`
- `is_nullable`: `YES`

### 2. Verificar que los registros existentes tienen `time = NULL`
```sql
SELECT COUNT(*) as total, COUNT(time) as with_time, COUNT(*) - COUNT(time) as without_time
FROM "AccountPayment";
```

**Resultado esperado**:
- `with_time`: `0` (todos los registros antiguos tienen `time = NULL`)
- `without_time`: igual a `total`

### 3. Probar creación de pago con hora
```bash
# Probar endpoint POST /api/v1/accounts/payment con campo time
curl -X POST http://localhost:3000/api/v1/accounts/payment \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "date": "2025-01-27",
    "time": "14:30",
    "amount": 1000,
    "type": "payment",
    "method": "cash",
    "ventanaId": "<ventana-id>"
  }'
```

**Verificar en BD**:
```sql
SELECT id, date, time, amount, type, "createdAt"
FROM "AccountPayment"
WHERE "createdAt" > NOW() - INTERVAL '5 minutes'
ORDER BY "createdAt" DESC
LIMIT 1;
```

**Resultado esperado**: El registro debe tener `time = '14:30'`

---

## ️ Consideraciones

### Compatibilidad
-  **Retrocompatible**: Los registros antiguos tienen `time = NULL` y funcionan igual que antes
-  **Opcional**: El campo es opcional, no rompe código existente
-  **Sin migración de datos**: No necesitamos migrar `createdAt` a `time` porque representan cosas diferentes

### Rendimiento
-  **Sin impacto**: Agregar una columna VARCHAR(5) nullable no afecta el rendimiento
-  **Sin índices**: No necesitamos índices en `time` porque se usa principalmente para ordenar dentro del mismo día

### Rollback (Si es necesario)
```sql
-- ️ SOLO si es absolutamente necesario hacer rollback
ALTER TABLE "AccountPayment" DROP COLUMN "time";
```

**Nota**: El rollback eliminará los datos de `time` de todos los registros. Solo hacerlo si es crítico.

---

##  Checklist de Deployment

- [ ] Backup de la base de datos (opcional pero recomendado)
- [ ] Ejecutar migración (`npx prisma migrate deploy` o SQL manual)
- [ ] Regenerar Prisma Client: `npx prisma generate`
- [ ] Verificar que la columna existe
- [ ] Verificar que registros antiguos tienen `time = NULL`
- [ ] **(Opcional)** Ejecutar backfill: `ts-node src/scripts/backfill-account-payment-time.ts --dry-run`
- [ ] **(Opcional)** Ejecutar backfill real: `ts-node src/scripts/backfill-account-payment-time.ts`
- [ ] Probar creación de pago con hora
- [ ] Verificar que el endpoint responde correctamente con `time`
- [ ] Verificar que el desglose día/sorteo intercala correctamente movimientos con hora

---

##  Referencias

- Documento de respuesta al FE: `docs/RESPUESTA_BE_HORA_PAGOS_COBROS.md`
- Schema Prisma: `prisma/schema.prisma` (modelo `AccountPayment`)
- Servicio de movimientos: `src/api/v1/services/accounts/accounts.movements.ts`
- Función de intercalación: `src/api/v1/services/accounts/accounts.intercalate.ts`

---

##  Estado

- [x] Migración creada
- [x] Instrucciones de deployment creadas
- [ ] Migración aplicada en producción
- [ ] Verificación post-deployment completada

