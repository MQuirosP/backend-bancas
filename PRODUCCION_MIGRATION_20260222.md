# Migración manual — Producción — 2026-02-22 noche

Este documento es para que Claude lo ejecute paso a paso en la noche.
Leer completo antes de empezar.

---

## Qué se corrige

1. **FK bug (bloqueante):** `sorteo_lista_exclusion.ventana_id` apuntaba incorrectamente a `User.id`.
   Debe apuntar a `Ventana.id`. La tabla nunca tuvo datos (el bug bloqueaba todos los inserts con P2003).

2. **`getExcludedListas`:** ahora lee directamente de `sorteo_lista_exclusion` (fuente de verdad),
   no de jugadas. El `vendedorId` del response refleja exactamente el scope original de la exclusión:
   `null` = ventana completa, `UUID` = vendedor específico.

3. **`getListas`:** `VendedorSummary` incluye nuevos campos `exclusionScope` y `exclusionRecordId`
   para que el FE pueda distinguir exclusiones de ventana vs vendedor y construir el include correcto.

## Archivos modificados (pendientes de commit)

- `prisma/schema.prisma`
- `prisma/migrations/20260222000000_fix_sorteo_lista_exclusion_ventana_fk/migration.sql`
- `src/api/v1/services/sorteo-listas.helpers.ts`
- `src/api/v1/services/sorteo-listas.service.ts`
- `src/api/v1/services/venta.service.ts`
- `src/api/v1/dto/sorteo-listas.dto.ts`

## Contexto crítico

- La migración ya está marcada como aplicada en `_prisma_migrations` de Supabase.
- `migrate deploy` la saltará — el SQL hay que aplicarlo a mano.
- El SQL va **antes** que el deploy del código.

> **Nota**: Si se restaura un dump en local o en producción antes de aplicar el SQL,
> el FK vuelve a `User` y hay que re-aplicar el ALTER TABLE. El dump pisa cambios manuales.
- Usar siempre `DIRECT_URL` (puerto 5432).

---

## PASO 1 — Leer el .env para obtener DIRECT_URL

```bash
grep DIRECT_URL .env
```

Guardar el valor. Se usará en todos los comandos psql siguientes.

---

## PASO 2 — Verificar estado actual en Supabase

```bash
psql "$DIRECT_URL" -c "
SELECT conname, confrelid::regclass AS references_table
FROM pg_constraint
WHERE conrelid = '\"sorteo_lista_exclusion\"'::regclass
  AND conname = 'sorteo_lista_exclusion_ventana_id_fkey';
"
```

Resultado esperado: `references_table = User`

Si dice `Ventana` — el fix ya fue aplicado, saltar al PASO 6.

```bash
psql "$DIRECT_URL" -c "SELECT COUNT(*) FROM \"sorteo_lista_exclusion\";"
```

Resultado esperado: `COUNT = 0`

Si `COUNT > 0` — **parar y avisar al usuario antes de continuar.**

---

## PASO 3 — Aplicar el fix

```bash
psql "$DIRECT_URL" -c "
BEGIN;

ALTER TABLE \"sorteo_lista_exclusion\"
  DROP CONSTRAINT \"sorteo_lista_exclusion_ventana_id_fkey\";

ALTER TABLE \"sorteo_lista_exclusion\"
  ADD CONSTRAINT \"sorteo_lista_exclusion_ventana_id_fkey\"
  FOREIGN KEY (ventana_id) REFERENCES \"Ventana\"(id)
  ON UPDATE CASCADE ON DELETE RESTRICT;

COMMIT;
"
```

Resultado esperado: `ALTER TABLE` x2

Si hay error — **no continuar, avisar al usuario.**

---

## PASO 4 — Verificar que el FK quedó correcto

```bash
psql "$DIRECT_URL" -c "
SELECT conname, confrelid::regclass AS references_table
FROM pg_constraint
WHERE conrelid = '\"sorteo_lista_exclusion\"'::regclass
  AND conname = 'sorteo_lista_exclusion_ventana_id_fkey';
"
```

Resultado esperado: `references_table = Ventana`

Si no es `Ventana` — **parar y avisar al usuario.**

---

## PASO 5 — Commitear y deployar el código

```bash
git add prisma/schema.prisma \
        prisma/migrations/20260222000000_fix_sorteo_lista_exclusion_ventana_fk/migration.sql \
        src/api/v1/services/sorteo-listas.helpers.ts \
        src/api/v1/services/sorteo-listas.service.ts \
        src/api/v1/services/venta.service.ts \
        src/api/v1/dto/sorteo-listas.dto.ts
```

```bash
git commit -m "fix: corregir FK ventana_id, mejorar getExcludedListas y agregar exclusionScope"
```

```bash
git push
```

Esperar a que el deploy complete antes de continuar.

---

## PASO 6 — Verificar los endpoints

**a) Exclusión:**
Hacer una petición de prueba a `POST /sorteos/:id/listas/exclude` con datos válidos
y confirmar que retorna 200 en vez de P2003.

**b) Listas excluidas:**
Llamar `GET /listas-excluidas?sorteoId=<id>` y confirmar que:

- Retorna registros con `vendedorId: null` para exclusiones de ventana completa
- El campo `id` es un UUID real (antes era `excluded-...`)

**c) getListas:**
Llamar `GET /sorteos/:id/listas?includeExcluded=true` y confirmar que los vendedores
excluidos tienen `exclusionScope: 'ventana'` o `'vendedor'` según corresponda.

---

## ROLLBACK — Solo si algo falla

Si el SQL falla o el endpoint sigue roto después del deploy, revertir el FK:

```bash
psql "$DIRECT_URL" -c "
BEGIN;

ALTER TABLE \"sorteo_lista_exclusion\"
  DROP CONSTRAINT \"sorteo_lista_exclusion_ventana_id_fkey\";

ALTER TABLE \"sorteo_lista_exclusion\"
  ADD CONSTRAINT \"sorteo_lista_exclusion_ventana_id_fkey\"
  FOREIGN KEY (ventana_id) REFERENCES \"User\"(id)
  ON UPDATE CASCADE ON DELETE RESTRICT;

COMMIT;
"
```

Y hacer `git revert` del commit. El endpoint vuelve al estado anterior (roto con P2003,
igual que antes de esta sesión — sin regresión).
