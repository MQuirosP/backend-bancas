# 🚀 Guía de Paso a Producción: Multi-Tenant (Supabase + Render)

Esta guía documenta el protocolo estricto para desplegar la arquitectura Multi-Tenant en el entorno de Producción real (Supabase). Se basa en el ensayo local exitoso, aplicando las secuencias de scripts de forma individual para máxima seguridad.

> [!WARNING]
> **TIEMPO DE INACTIVIDAD ESPERADO:** 15 - 20 minutos.
> Se recomienda programar esta migración en la madrugada (ej. 2:00 AM) cuando las ventas están cerradas.

---

## 🛑 Fase 1: Pausa y Respaldo (Minuto 0)

Para evitar que entren datos nuevos mientras se migran los históricos, la aplicación debe dejar de recibir tráfico obligatoriamente.

1. **Pausar el Backend en Render:**
   - Ve al [Dashboard de Render](https://dashboard.render.com).
   - Entra al servicio del Backend.
   - En la pestaña **Settings**, busca la opción **Suspend Web Service** (o activa tu variable de entorno de mantenimiento).

2. **Auditoría Final de Salud:**
   - Abre tu terminal local asegurándote de que tu `.env` apunta a la Base de Datos de **Producción** (usando la connection_url del Pooler).
   - Ejecuta:

     ```powershell
     node migration_scripts/pre_migration_audit_v2.js
     ```

     *(Verifica que no haya nulos críticos ni problemas bloqueantes antes de empezar)*

---

## ⚡ Fase 2: El Día "D" — Ejecución de la Migración

Dado que el orquestador automático fue descartado por seguridad, se deben ejecutar los scripts uno por uno en este **orden estricto**.

### 1. Curación de Datos (Backfill)

Rellena la columna `bancaId` en todo el histórico.

```powershell
npx ts-node migration_scripts/complete_backfill.ts
```

*(Al finalizar, vuelve a ejecutar el `pre_migration_audit_v2.js` para confirmar que los Nulos ahora son 0).*

### 2. Sincronización Estructural (Prisma Push)

Primero limpiamos índices conflictivos:

```powershell
npx ts-node migration_scripts/fix_indexes.ts
```

Luego inyectamos las nuevas columnas y llaves foráneas a la base de datos:

```powershell
npx prisma db push
```

> [!CAUTION]
> Si Prisma arroja una advertencia amarilla preguntando si deseas resetear la base de datos o si habrá "Data Loss", responde **SIEMPRE `n` (No)**. Nunca uses `--accept-data-loss`.

### 3. Inyección de Índice Concurrente

Para optimizar el pool de sesiones del vendedor:

```powershell
npx ts-node migration_scripts/add_session_pool_index.ts
```

### 4. Clonado de Loterías por Banca

Genera el catálogo independiente para cada banca.

```powershell
npx ts-node migration_scripts/clone-loterias-multi-tenant.ts
```

### 5. Migración de Reglas de Restricción

Vincula las reglas existentes al nuevo catálogo clonado.

```powershell
npx ts-node migration_scripts/migrate_restriction_rules.ts
```

### 6. Recreación de Vistas Materializadas SQL

Abre el editor SQL de Supabase (o usa `psql`) y ejecuta completo el contenido de:

- [migration_scripts/migrate_views_tenant.sql](file:///c:/Users/mquir/Proyectos/Bancas/backend/migration_scripts/migrate_views_tenant.sql)

### 7. Poblado de la Tabla de Cierres Diarios

Rellena el histórico para el nuevo Dashboard.

```powershell
npx tsx migration_scripts/backfill_rollup.ts
```

---

## 🟢 Fase 3: Despliegue del Nuevo Backend y Reactivación (Minuto 20)

1. **Configurar Zona Horaria en Render:**
   - En el dashboard de Render, asegúrate de tener la variable:
     `BUSINESS_TIMEZONE = America/Costa_Rica`

2. **Reactivar Tráfico y Desplegar Código:**
   - Haz Deploy de tu rama (o la rama principal consolidada) en Render.
   - Quita la suspensión del servicio ("Resume Web Service").

3. **Limpieza de Sesiones (Corte Limpio Multi-Tenant):**
   Para asegurar que todos los usuarios re-inicien sesión y carguen el nuevo contexto, sin borrar la caché de Redis compartida:
   - **En Supabase SQL Editor:** Ejecuta `TRUNCATE TABLE "RefreshToken";`
   - **En Render:** Cambia levemente el valor de `JWT_ACCESS_SECRET` y `JWT_REFRESH_SECRET` (ej. agrégales un número al final). Esto expulsa a todos los usuarios a la pantalla de Login sin usar el prohibido `FLUSHDB`.

4. **Smoke Test Rápido:**
   - Entra al Frontend como un Administrador Global.
   - Entra como un Vendedor normal.
   - Verifica que el vendedor **solo ve los tickets de su propia banca**.
   - Genera un ticket de prueba y confirma que aparece en los reportes de su banca.

5. **Trigger de Autocuración de Sorteos Automáticos:**
   - Realiza una consulta GET al endpoint `/api/v1/sorteos/auto-status` (o entra a la sección de automatización de sorteos en el frontend como Admin).
   - *¿Qué sucede detrás de escena?* El backend ejecutará la lógica programática de consolidación, curará la base de datos de producción eliminando las filas duplicadas de `SorteosAutoConfig` y fusionará los históricos de ejecución en el registro principal de manera transparente.
   - Confirma en consola o logs que el estado de salud retorne exitosamente.

🎉 **¡MIGRACIÓN COMPLETADA!**

---

## ⏭️ Fase 4: Siguientes Pasos (Migraciones Posteriores)

- [ ] **Aislamiento de Consecutivos (V5 - Fase II):** Para implementar el folio dinámico por banca de forma 100% segura y sin downtime, programar como una Fase II independiente una vez que el Multi-Tenant actual esté consolidado y operando de forma estable en producción. Consultar el documento completo en [PLAN_CONSECUTIVOS_TICKETS.md](file:///c:/Users/mquir/Proyectos/Bancas/backend/PLAN_CONSECUTIVOS_TICKETS.md).
