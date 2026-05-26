# ðŸš€ GuÃ­a de Paso a ProducciÃ³n: Multi-Tenant (Supabase + Render)

Esta guÃ­a documenta el protocolo estricto para desplegar la arquitectura Multi-Tenant en el entorno de ProducciÃ³n real. A diferencia del ensayo local, aquÃ­ aprovechamos el poder del motor de Supabase para minimizar el tiempo de inactividad (Downtime).

> [!WARNING]
> **TIEMPO DE INACTIVIDAD ESPERADO:** 15 - 20 minutos.
> Se recomienda programar esta migraciÃ³n en la madrugada (ej. 2:00 AM) cuando las ventas estÃ¡n cerradas.

---

## ðŸ›‘ Fase 1: Pausa y Respaldo (Minuto 0)

Para evitar un *"Deadlock"* o datos corruptos, la aplicaciÃ³n debe dejar de recibir trÃ¡fico.

1. **Pausar el Backend en Render:**
   - Ve al [Dashboard de Render](https://dashboard.render.com).
   - Entra al servicio del Backend.
   - En la pestaÃ±a **Settings**, busca la opciÃ³n **Suspend Web Service** (o activa una variable de entorno de mantenimiento si la tienes programada en el Frontend).
2. **AuditorÃ­a Final de Salud:**
   - Desde tu terminal local (asegurando que el `.env` apunta a Supabase ProducciÃ³n):
     ```powershell
     node migration_scripts/pre_migration_audit_v2.js
     ```

---

## âš¡ Fase 2: El DÃ­a "D" â€” EjecuciÃ³n de la MigraciÃ³n Multi-Tenant

Dado que el motor de Supabase bloquea scripts SQL masivos por `statement_timeout`, he preparado un **Orquestador de ProducciÃ³n** (`migration_scripts/run_production_migration.ts`). Este script es idÃ©ntico al de ensayo, **PERO no tiene la Fase 0**. Es decir, arranca directamente actualizando, sin borrar datos histÃ³ricos.

### Pasos Maestros:
1. AsegÃºrate de que el `.env` de tu servidor de ProducciÃ³n apunta a la base de datos de ProducciÃ³n (con la connection_url del Pooler).
2. **Apaga el servidor web (Render)** para que no entren mÃ¡s tickets y la base de datos quede congelada en el tiempo.
3. Abre una terminal conectada a tu servidor o entorno con acceso a la base de datos.
4. Ejecuta el orquestador maestro:
   ```bash
   npx ts-node migration_scripts/run_production_migration.ts
   ```
   
> [!NOTE]
> **¿Qué hace el Orquestador automáticamente?**
> - **Fase 1:** Auditoría Pre-Migración (`pre_migration_audit_v2.js`).
> - **Fase 2:** Curación de Datos (`complete_backfill_production.ts`) que procesa 3.6M+ jugadas en lotes con exponential backoff, elimina huérfanos, y mapea inteligentemente los cierres históricos en `MonthlyClosingBalance` hacia sus respectivas bancas.
> - **Fase 2.5:** Limpieza preventiva de Índices (`fix_indexes.ts`) para evitar choques en Supabase.
> - **Fase 3:** Sincronización Estructural (`prisma db push`) para inyectar constraints Multi-Tenant.
> - **Fase 3.5:** *[NUEVO]* Inyección de Índice Concurrente (`add_session_pool_index.ts`) para optimizar el Pool de Sesiones.
> - **Fase 4:** Clonado de Loterías por Banca (`clone-loterias-multi-tenant.ts`).
> - **Fase 4.5:** *[NUEVO]* Migración de Reglas de Restricción preexistentes a catálogos locales (`migrate_restriction_rules.ts`).
> - **Fase 5:** Recreación de Vistas Materializadas SQL (`create_views_tenant.ts`).
> - **Fase 5.5:** Poblado Inicial de la Tabla de Cierres Diarios Rollup (`backfill_rollup.ts`).

## ðŸŸ¢ Fase 3: ReactivaciÃ³n y VerificaciÃ³n (Minuto 20)

1. **Reactivar TrÃ¡fico:**
   - Ve a Render y quita la suspensiÃ³n del servicio ("Resume Web Service").
2. **Smoke Test:**
   - Entra al Frontend como un Administrador Global.
   - Entra como un Vendedor normal.
   - Verifica que el vendedor **solo ve los tickets de su propia banca**.
   - Genera un ticket de prueba y verifica que aparece instantÃ¡neamente en los reportes de su banca correspondiente.
3. **Verificar Dashboard Performance:**
   - Navega al Dashboard con `date=week` â€” debe cargar en menos de 2 segundos.
   - Verifica que los montos coincidan con los reportes.

ðŸŽ‰ **Â¡MIGRACIÃ“N COMPLETADA!** 
Si algo catastrÃ³fico llegara a pasar durante los primeros 5 minutos, refiÃ©rete a los respaldos de Supabase (PITR).
