# ðŸ›¡ï¸ GuÃ­a de Ensayo de MigraciÃ³n (Local)

Esta guÃ­a detalla los pasos para realizar ensayos locales antes de la migraciÃ³n a ProducciÃ³n.

> [!IMPORTANT]
> **Antes de cualquier paso**: Verificar que `DATABASE_URL` apunta a la base de datos correcta:
>
> ```powershell
> npx ts-node migration_scripts/verify_env.ts
> ```

---

## 0. Fase 0: Resetear Entorno Local con Datos Frescos

Para que el ensayo local sea 100% realista, debemos borrar cualquier migraciÃ³n de prueba previa en la base de datos local y traer una copia idÃ©ntica de la ProducciÃ³n actual.

- [ ] **Descargar Dump de ProducciÃ³n**:
  Extraer la base de datos de Supabase. (Usar puerto 5432 directo en lugar del pooler 6543 para evitar timeouts).

  ```powershell
  pg_dump -Fc "postgresql://[USUARIO]:[CONTRASEÃ‘A]@[HOST_SUPABASE]:5432/postgres?sslmode=require" -f "supabase_prod_fresco.dump"
  ```

- [ ] **Limpiar Esquema Local**:
  Antes de restaurar, la base de datos local (`bancas_test`) debe estar completamente vacÃ­a para evitar errores de llaves forÃ¡neas. Ejecutar un script para hacer un wipe de seguridad:

  ```powershell
  node migration_scripts/wipe_db.js
  ```
  *(Nota: El script wipe_db.js ya estÃ¡ configurado para borrar el esquema de forma segura y restaurar automÃ¡ticamente las extensiones requeridas como `citext` y `pg_trgm`).*

- [ ] **Restaurar el Dump Localmente**:
  Usar los flags `--no-owner --no-acl` para evitar fallos de roles, y **NO usar** `-1` (single transaction) para que no se haga rollback completo si falla la creaciÃ³n de algÃºn Ã­ndice menor.

  ```powershell
  pg_restore -n public --no-owner --no-acl -d postgresql://postgres:3az5bkhr@localhost:5432/bancas_test supabase_prod_fresco.dump
  ```

---

## 1. Fase de PreparaciÃ³n (D-Day - 2 dÃ­as)

- [ ] **AuditorÃ­a Pre-MigraciÃ³n**: Ejecutar y resolver TODOS los âŒ antes de continuar.

  ```powershell
  node migration_scripts/pre_migration_audit_v2.js
  ```

  Verifica: duplicados bloqueantes en `Sorteo` y `Loteria`, nulos por tabla, usuarios sin ventana, bancaId huÃ©rfanos.

- [ ] **Backup de Seguridad**: Volcado completo justo antes del D-Day.

  ```powershell
  pg_dump -Fc $env:DATABASE_URL -f "backup_pre_migration_$(Get-Date -Format 'yyyyMMdd_HHmm').dump"
  ```

  > [!CAUTION]
  > Guardar el backup en un lugar seguro **fuera** del repositorio. Es el Ãºnico salvavidas ante un fallo crÃ­tico.

---

## 2. Fase de Backfill (CuraciÃ³n de Datos)

Puebla `bancaId` en los registros histÃ³ricos para que los nuevos constraints de integridad no fallen.

- [ ] **EjecuciÃ³n del Backfill**:

  ```powershell
  npx ts-node migration_scripts/complete_backfill.ts
  ```

  Procesa en orden: Usuarios â†’ Tickets â†’ Jugadas (en lotes de 50k) â†’ AccountStatements.
  Al final reporta el conteo post-ejecuciÃ³n. **Debe terminar con 0 nulos**.

- [ ] **VerificaciÃ³n de Nulos** (confirmar antes de continuar):

  ```powershell
  node migration_scripts/pre_migration_audit_v2.js
  ```

  El resultado del CHECK 3 debe ser 0 en todas las tablas crÃ­ticas.

> [!IMPORTANT]
> **No continuar a la Fase 3 si quedan nulos**. El `db push` fallarÃ¡ con errores de constraint.

---

## 3. Fase de Aislamiento de LoterÃ­as y Comisiones

- [ ] **Pre-Limpieza de Ãndices**: Para evitar que Prisma falle con el error `"already exists"` al intentar crear los nuevos constraints multi-tenant, limpia los Ã­ndices antiguos primero:

  ```powershell
  npx ts-node migration_scripts/fix_indexes.ts
  ```

- [ ] **SincronizaciÃ³n de Esquema**: Aplica las nuevas columnas, FKs y constraints limpios.

  ```powershell
  npx prisma db push
  ```
  *(Responde `y` si Prisma advierte sobre pÃ©rdida de datos por duplicados).*

  > [!CAUTION]
  > Si falla con `foreign key constraint` o `violates foreign key`, el backfill no estÃ¡ completo. Volver al Paso 2 y verificar que el conteo de nulos sea 0.

- [ ] **Clonado y Bootstrap**:

  ```powershell
  npx ts-node migration_scripts/clone-loterias-multi-tenant.ts
  ```

  - Crea copias de loterÃ­as/multiplicadores por banca.
  - Genera sorteos de **HOY** en estado `OPEN` para operatividad inmediata.
  - Re-mapea polÃ­ticas de comisiÃ³n en Usuarios y Ventanas.

- [ ] **MigraciÃ³n de Reglas de RestricciÃ³n**:

  ```powershell
  npx ts-node migration_scripts/migrate_restriction_rules.ts
  ```

  - Actualiza las reglas de restricciÃ³n preexistentes para que apunten a los nuevos IDs de loterÃ­as y multiplicadores locales (clonados) de cada banca.

- [ ] **MigraciÃ³n de Vistas Materializadas (Aislamiento & IndexaciÃ³n)**:

  > [!IMPORTANT]
  > Dado que el nuevo cÃ³digo de la app espera que la columna `bancaId` exista en las vistas materializadas para renderizar reportes rÃ¡pidos y seguros, debemos recrear las vistas materializadas **antes** de desplegar el cÃ³digo en Render.

  Ejecutar el script SQL de migraciÃ³n en el editor SQL de Supabase (o vÃ­a `psql`):
  * **Archivo de MigraciÃ³n:** [migration_scripts/migrate_views_tenant.sql](file:///c:/Users/mquir/Proyectos/Bancas/backend/migration_scripts/migrate_views_tenant.sql)

  *Esto elimina las vistas viejas, crea las nuevas con la columna `bancaId`, genera Ã­ndices Ãºnicos compuestos para permitir `REFRESH CONCURRENTLY` e Ã­ndices rÃ¡pidos de bÃºsqueda.*

- [ ] **Poblado de la Tabla de Cierres Diarios (Incremental Rollup)**:
  Ejecutar el script de backfill masivo para poblar la nueva tabla `ResumenCierreDiario` que se encarga ahora de los reportes histÃ³ricos.

  ```powershell
  npx tsx migration_scripts/backfill_rollup.ts
  ```

---

## 4. Fase de Endurecimiento (Hardening)

- [ ] **Variable de entorno en Render**: Antes de desplegar, agregar en el dashboard de Render:

  | Variable | Valor |
  |---|---|
  | `BUSINESS_TIMEZONE` | `America/Costa_Rica` |

  > [!IMPORTANT]
  > Sin esta variable el sistema usa el default `America/Costa_Rica`, pero es obligatorio declararla explÃ­citamente en Render para garantizar consistencia con el entorno local y poder cambiarla sin redeploy de cÃ³digo.

- [ ] **Despliegue de CÃ³digo**: Subir la rama `feature/multi-tenant-neon` a Render.
- [ ] **SincronizaciÃ³n Final** (si `db push` del paso 3 no fue suficiente):

  ```powershell
  npx prisma db push
  ```

---

## 5. Fase de VerificaciÃ³n

- [ ] **Check Final de Nulos**:

  ```powershell
  node migration_scripts/pre_migration_audit_v2.js
  ```

- [ ] **Smoke Test**: Verificar en el Frontend que cada banca ve solo sus sorteos, tickets y vendedores.

---

## ðŸ”„ Plan de Rollback

En caso de fallo, escalar segÃºn la gravedad:

### Nivel 1 â€” Rollback de CÃ³digo (2 min)

Si la app se comporta mal pero la BD estÃ¡ intacta:

```powershell
# En Render: revertir al deploy anterior con un click en el dashboard.
```

### Nivel 2 â€” Rollback de Schema & Vistas Materializadas (10-15 min)

Si el `db push` aplicÃ³ constraints problemÃ¡ticos o si se requiere revertir las vistas materializadas:

1. **Para revertir constraints de tablas base**, ejecutar en el editor SQL de Supabase la secciÃ³n **NIVEL 2** de:
   * [migration_scripts/rollback_migration.sql](file:///c:/Users/mquir/Proyectos/Bancas/backend/migration_scripts/rollback_migration.sql)
2. **Para revertir las vistas materializadas** a su esquema original sin `bancaId`, ejecutar completo el script:
   * [migration_scripts/rollback_views_tenant.sql](file:///c:/Users/mquir/Proyectos/Bancas/backend/migration_scripts/rollback_views_tenant.sql)

### Nivel 3 â€” Rollback de Datos (20-30 min)

Si el backfill corrompiÃ³ datos (des-vincula `bancaId` de los registros histÃ³ricos sin borrar nada):

Ejecutar en el editor SQL de Supabase la secciÃ³n **NIVEL 3** de:
* [migration_scripts/rollback_migration.sql](file:///c:/Users/mquir/Proyectos/Bancas/backend/migration_scripts/rollback_migration.sql)

### Nivel 4 â€” RestauraciÃ³n desde Backup (30+ min, Ãºltimo recurso)

```powershell
pg_restore --clean --if-exists -d $env:DATABASE_URL backup_pre_migration_YYYYMMDD_HHmm.dump
```

> [!CAUTION]
> Borra TODOS los datos creados despuÃ©s del backup. Confirmar con el equipo.

---

## ðŸš€ Mejoras Post-MigraciÃ³n

- [ ] **Aprovisionamiento Total**: El flag `importBaseLoterias` en la creaciÃ³n de nuevas Bancas:
  - Clona automÃ¡ticamente loterÃ­as y multiplicadores de la configuraciÃ³n global.
  - Genera sorteos para el dÃ­a en curso al instante en estado `OPEN`.

---

## ðŸ“ Mapa de Scripts

| Script | PropÃ³sito | Seguro para releer |
|---|---|---|
| `migration_scripts/verify_env.ts` | Confirmar a quÃ© DB estamos conectados | âœ… Solo lectura |
| `migration_scripts/pre_migration_audit_v2.js` | AuditorÃ­a GO/NO-GO pre-migraciÃ³n | âœ… Solo lectura |
| `migration_scripts/complete_backfill.ts` | Backfill de `bancaId` en tablas histÃ³ricas | âš ï¸ Modifica datos |
| `migration_scripts/clone-loterias-multi-tenant.ts` | Clona loterÃ­as y siembra sorteos por banca | âš ï¸ Modifica datos |
| `migration_scripts/migrate_views_tenant.sql` | SQL de migraciÃ³n de vistas materializadas | âœ… Solo referencia |
| `migration_scripts/rollback_views_tenant.sql` | SQL de reversiÃ³n de vistas materializadas | âœ… Solo referencia |
| `migration_scripts/rollback_migration.sql` | SQL de rollback base por niveles | âœ… Solo referencia |
| `migration_scripts/fix_indexes.ts` | Limpieza de Ã­ndices base conflictivos | âš ï¸ Modifica schema |
| `migration_scripts/run_migration_dryrun.ts` | Orquestador automÃ¡tico del ensayo general | âš ï¸ Modifica localmente |
