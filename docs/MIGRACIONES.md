# 📘 Guía Completa de Migraciones de Base de Datos

## 📋 Tabla de Contenidos

1. [Conceptos Básicos](#conceptos-básicos)
2. [Preparación del Entorno](#preparación-del-entorno)
3. [Flujo de Trabajo de Migraciones](#flujo-de-trabajo-de-migraciones)
4. [Comandos Disponibles](#comandos-disponibles)
5. [Escenarios Comunes](#escenarios-comunes)
6. [Troubleshooting](#troubleshooting)
7. [Mejores Prácticas](#mejores-prácticas)

---

## 🎯 Conceptos Básicos

### ¿Qué es una Migración?

Una migración es un archivo que describe **cambios en la estructura de la base de datos**:
- Agregar/eliminar columnas
- Crear/eliminar tablas
- Modificar índices
- Cambiar tipos de datos

### ¿Por qué NO usar `db push` en producción?

| Característica | `db push` | `migrate deploy` |
|----------------|-----------|------------------|
| **Historial** | ❌ No guarda historial | ✅ Registro en `_prisma_migrations` |
| **Rollback** | ❌ No reversible | ✅ Puede revertirse |
| **Seguridad** | ⚠️ Puede perder datos | ✅ Requiere migraciones explícitas |
| **Uso** | Solo desarrollo | Producción y desarrollo |

**Regla de oro:** Usa `db push` SOLO en desarrollo local, NUNCA en producción.

---

## 🛠️ Preparación del Entorno

### Nota Importante: Configuración de Prisma

**Este proyecto NO usa `prisma.config.ts`** - fue eliminado porque bloqueaba la carga de variables de entorno desde `dotenv-cli`.

Prisma ahora carga variables directamente desde `.env.local` usando el comando:
```bash
npx dotenv-cli -e .env.local -- prisma [comando]
```

### 1. Archivos de Configuración

#### `.env.local` (Desarrollo)
```env
DATABASE_URL=postgresql://postgres.xhwxiofujvoaszojcoml:PASSWORD@aws-1-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true
DIRECT_URL=postgresql://postgres.xhwxiofujvoaszojcoml:PASSWORD@db.xhwxiofujvoaszojcoml.supabase.co:5432/postgres?sslmode=require
```

#### `.env.test` (Testing)
```env
DATABASE_URL=postgresql://localhost:5432/bancas_test
DIRECT_URL=postgresql://localhost:5432/bancas_test
```

### 2. Verificar Conexión

```bash
# Ver estado de migraciones
npm run migrate:status
```

Si todo está bien, verás:
```
Database schema is up to date!
```

---

## 🔄 Flujo de Trabajo de Migraciones

### Flujo Completo: Desarrollo → Producción

```mermaid
graph LR
    A[1. Modificar schema.prisma] --> B[2. Crear migración]
    B --> C[3. Revisar SQL generado]
    C --> D[4. Aplicar en desarrollo]
    D --> E[5. Probar cambios]
    E --> F[6. Commit a Git]
    F --> G[7. Deploy a producción]
    G --> H[8. Aplicar migración]
```

---

## 📦 Comandos Disponibles

### Desarrollo

#### Crear Nueva Migración
```bash
npm run migrate:create
```
- Crea archivo de migración **sin aplicarlo**
- Útil para revisar el SQL antes de aplicar

#### Crear y Aplicar Migración
```bash
npm run migrate:dev
```
- Crea migración
- La aplica a la BD
- Regenera Prisma Client

#### Aplicar Migración Existente
```bash
npm run migrate:deploy
```
- Aplica migraciones pendientes
- **Incluye verificación de seguridad**

#### Ver Estado de Migraciones
```bash
npm run migrate:status
```
- Muestra migraciones aplicadas
- Muestra migraciones pendientes

#### Sincronizar Schema (Desarrollo SOLO)
```bash
npm run db:push
```
⚠️ **NUNCA usar en producción**

### Producción

#### Aplicar Migraciones en Producción
```bash
npm run migrate:deploy
```

Script de seguridad incluido que:
- ✅ Verifica variables de entorno
- ✅ Detecta si es producción
- ✅ Muestra advertencia antes de aplicar

---

## 🎬 Escenarios Comunes

### Escenario 1: Agregar Columna a Tabla Existente

#### Paso 1: Modificar `schema.prisma`

```prisma
model Ticket {
  id            String   @id @default(uuid())
  ticketNumber  String   @unique
  // ... campos existentes

  // ✅ NUEVO CAMPO
  clienteNombre String?  @default("CLIENTE CONTADO") @db.VarChar(100)
}
```

#### Paso 2: Crear Migración

```bash
npm run migrate:create
```

Prisma preguntará:
```
? Enter a name for the new migration:
```

Escribe: `add_cliente_nombre_to_ticket`

#### Paso 3: Revisar SQL Generado

Archivo creado en: `src/prisma/migrations/YYYYMMDDHHMMSS_add_cliente_nombre_to_ticket/migration.sql`

```sql
-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN "clienteNombre" VARCHAR(100) DEFAULT 'CLIENTE CONTADO';
```

#### Paso 4: Aplicar en Desarrollo

```bash
npm run migrate:dev
```

#### Paso 5: Probar

```bash
# Regenerar tipos
npm run prisma:generate

# Verificar typecheck
npm run typecheck

# Probar en servidor
npm run dev
```

#### Paso 6: Commit

```bash
git add .
git commit -m "feat: add clienteNombre field to Ticket model"
git push
```

#### Paso 7: Aplicar en Producción

**⚠️ IMPORTANTE: Usar Supabase Dashboard**

Debido a restricciones de autenticación, es más confiable aplicar migraciones directamente en Supabase:

**Opción A: Supabase Dashboard (RECOMENDADO)**
1. Ir a [Supabase Dashboard](https://supabase.com/dashboard/project/xhwxiofujvoaszojcoml/sql)
2. Abrir SQL Editor
3. Copiar contenido de `migration.sql`
4. Ejecutar el SQL
5. (Opcional) Registrar en `_prisma_migrations` si quieres tracking:

```sql
INSERT INTO "_prisma_migrations" (
  id, checksum, finished_at, migration_name,
  started_at, applied_steps_count
) VALUES (
  gen_random_uuid(),
  'checksum-here',
  NOW(),
  '20251102110021_add_cliente_nombre_to_ticket',
  NOW(),
  1
);
```

---

### Escenario 2: Cambiar Tipo de Columna

⚠️ **CUIDADO: Puede perder datos**

#### Ejemplo: VARCHAR(50) → VARCHAR(100)

```prisma
model User {
  name String @db.VarChar(100)  // Antes: @db.VarChar(50)
}
```

```bash
npm run migrate:create
```

SQL generado:
```sql
ALTER TABLE "User" ALTER COLUMN "name" TYPE VARCHAR(100);
```

✅ **Seguro:** Ampliar tamaño
❌ **Peligroso:** Reducir tamaño (puede truncar datos)

---

### Escenario 3: Agregar Relación

```prisma
model Ticket {
  id         String @id
  sorteoId   String
  sorteo     Sorteo @relation(fields: [sorteoId], references: [id])

  @@index([sorteoId])
}
```

SQL generado:
```sql
-- CreateIndex
CREATE INDEX "Ticket_sorteoId_idx" ON "Ticket"("sorteoId");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_sorteoId_fkey"
  FOREIGN KEY ("sorteoId") REFERENCES "Sorteo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

---

### Escenario 4: Migración Falló - ¿Cómo Resolver?

#### Error: "Migration failed to apply"

```bash
npm run migrate:status
```

Verás:
```
Following migration have failed:
20251102110021_add_cliente_nombre_to_ticket
```

**Solución:**

```bash
# Marcar como aplicada (si ya se aplicó manualmente)
npm run migrate:resolve -- --applied 20251102110021_add_cliente_nombre_to_ticket

# O marcar como revertida (si quieres volver a aplicar)
npm run migrate:resolve -- --rolled-back 20251102110021_add_cliente_nombre_to_ticket
```

---

## 🐛 Troubleshooting

### Error: "P1000: Authentication failed"

**Causa:** Credenciales incorrectas en `.env.local`

**Solución:**
```bash
# 1. Verificar variables
cat .env.local | grep DATABASE_URL

# 2. Probar conexión
npm run migrate:status

# 3. Si falla, actualizar credenciales en .env.local
```

---

### Error: "The column X does not exist"

**Causa:** Migración no aplicada en base de datos

**Solución:**
```bash
# Ver migraciones pendientes
npm run migrate:status

# Aplicar migraciones
npm run migrate:deploy
```

---

### Error: "Migration X is already applied"

**Causa:** Intentando aplicar migración duplicada

**Solución:**
```bash
# Ver estado
npm run migrate:status

# Si es duplicado, eliminar archivo de migración local
rm -rf src/prisma/migrations/20251102110021_duplicate_migration
```

---

### Error: "prisma.config.ts blocks environment variables"

**Causa:** Prisma 6 con `prisma.config.ts` bloquea variables de entorno de dotenv-cli

**Solución:** ✅ Ya está arreglado en este proyecto
- `prisma.config.ts` fue **eliminado** del proyecto
- Ahora usamos el enfoque estándar de Prisma con dotenv-cli
- Todos los comandos usan: `npx dotenv-cli -e .env.local -- prisma [comando]`

---

### Error: "P1000: Authentication failed" al ejecutar migraciones desde CLI

**Causa:** Restricciones de red/autenticación con Supabase

**Solución:**
```bash
# En lugar de ejecutar desde CLI local:
npm run migrate:deploy

# Ejecutar SQL directamente en Supabase Dashboard:
# 1. Ir a SQL Editor en Supabase
# 2. Copiar contenido de migration.sql
# 3. Ejecutar manualmente
```

**Nota:** Esto es normal con bases de datos alojadas que tienen restricciones de IP/firewall.

---

## ✅ Mejores Prácticas

### 1. **Siempre revisar SQL antes de aplicar**

```bash
# Crear sin aplicar
npm run migrate:create

# Revisar archivo generado
cat src/prisma/migrations/*/migration.sql

# Si está bien, aplicar
npm run migrate:dev
```

### 2. **Nunca modificar migraciones aplicadas**

❌ **MAL:**
```bash
# Modificar migración ya aplicada
vim src/prisma/migrations/20251101_old/migration.sql
```

✅ **BIEN:**
```bash
# Crear nueva migración
npm run migrate:create
```

### 3. **Usar nombres descriptivos**

✅ **BIEN:**
- `add_cliente_nombre_to_ticket`
- `create_payment_table`
- `add_index_to_sorteo_scheduled_at`

❌ **MAL:**
- `migration_1`
- `fix`
- `update`

### 4. **Probar en desarrollo primero**

```bash
# 1. Desarrollo
npm run migrate:dev

# 2. Testing
npm run test

# 3. Verificar servidor
npm run dev

# 4. Si todo funciona → Producción
npm run migrate:deploy
```

### 5. **Backup antes de migraciones grandes**

```bash
# Backup desde Supabase Dashboard
# Settings → Database → Backup → Create Backup
```

### 6. **Documentar cambios complejos**

```sql
-- migration.sql
--
-- Esta migración agrega soporte para nombres de clientes
-- Valor por defecto: "CLIENTE CONTADO"
-- Afecta: ~50,000 tickets existentes
--
ALTER TABLE "Ticket" ADD COLUMN "clienteNombre" VARCHAR(100) DEFAULT 'CLIENTE CONTADO';
```

---

## 📊 Checklist de Migración

Usa este checklist antes de cada migración en producción:

- [ ] ✅ Migración probada en desarrollo
- [ ] ✅ Tests pasan (npm run test)
- [ ] ✅ TypeCheck pasa (npm run typecheck)
- [ ] ✅ SQL revisado manualmente
- [ ] ✅ Backup de base de datos creado
- [ ] ✅ Variables de entorno verificadas
- [ ] ✅ Migración commiteada a Git
- [ ] ✅ Equipo notificado (si aplica)

---

## 🚨 Comandos de Emergencia

### Revertir Última Migración (¡CUIDADO!)

⚠️ **Esto puede perder datos**

```sql
-- 1. Ver última migración
SELECT * FROM "_prisma_migrations" ORDER BY finished_at DESC LIMIT 1;

-- 2. Revertir cambios manualmente (ejemplo)
ALTER TABLE "Ticket" DROP COLUMN "clienteNombre";

-- 3. Eliminar registro
DELETE FROM "_prisma_migrations"
WHERE migration_name = '20251102110021_add_cliente_nombre_to_ticket';
```

### Reiniciar Base de Datos (Solo Desarrollo)

⚠️ **ESTO ELIMINA TODOS LOS DATOS**

```bash
# SOLO EN DESARROLLO - NUNCA EN PRODUCCIÓN
npx dotenv-cli -e .env.local -- prisma migrate reset --schema=./src/prisma/schema.prisma
```

---

## 📞 Contacto y Ayuda

Si tienes problemas:
1. Revisa esta documentación
2. Verifica logs: `npm run migrate:status`
3. Consulta [Prisma Docs](https://www.prisma.io/docs/concepts/components/prisma-migrate)

---

**Última actualización:** 2025-11-02
**Versión:** 1.0.0
