# Plan Consolidado de Optimizaciones - 2026-02-15

---

## Parte A: Completado hoy (en produccion)

### A1. Auth Middleware — bancaId en JWT

**Archivos modificados:**
- `src/api/v1/services/auth.service.ts` (login + refresh)
- `src/middlewares/auth.middleware.ts`
- `src/middlewares/bancaContext.middleware.ts`

**Que se hizo:**
- Se agrego `bancaId` al payload del JWT (obtenido de la ventana del usuario al hacer login/refresh)
- `bancaContext.middleware.ts` ahora usa `user.bancaId` del JWT directamente, sin query a BD
- Fallback para JWTs viejos que no tienen bancaId: resuelve desde BD como antes

**Impacto:** Elimino 1-2 queries por request para VENTANA/VENDEDOR (ventana.findUnique + banca check).

---

### A2. Auth Middleware — Cache Redis para ventanaId (VENDEDOR)

**Archivos modificados:**
- `src/middlewares/auth.middleware.ts`
- `src/api/v1/services/user.service.ts` (invalidacion)

**Que se hizo:**
- Para usuarios VENDEDOR, se cachea la validacion de `ventanaId` en Redis (TTL 5 min)
- Se usa wrapper `{ v: ventanaId }` para evitar bug de doble serializacion (CacheService.set + Upstash REST)
- Cuando se cambia `ventanaId` de un usuario, se invalida su cache (`CacheService.del`)

**Bug resuelto:** Upstash REST API hace `JSON.stringify(value)` en el body, y `CacheService.set` tambien. Strings crudos se doble-escapan (`"\"uuid\""`) causando error de Prisma UUID. Solucion: envolver en objeto.

**Impacto:** Elimino 1 query por request para VENDEDOR (user.findUnique para validar ventanaId).

---

### A3. Balance endpoint — AccountStatement fast path

**Archivo modificado:** `src/api/v1/services/accounts/accounts.service.ts`

**Que se hizo:**
- En `getMonthlyRemainingBalance()`: se desccomento el retorno directo desde AccountStatement
- Se cambio filtro de fecha para incluir hoy (`lte: endDate` en vez de `lt: todayCR`)
- Fallback a `getStatementDirect()` solo para ventanas nuevas sin AccountStatement

**Impacto:** `GET /api/v1/accounts/balance/current` paso de **53s** a **2.7s**.

---

### A4. Ventas Summary — AccountStatement fast path

**Archivo modificado:** `src/api/v1/services/venta.service.ts`

**Que se hizo:**
- Se agrego fast path al inicio de `summary()`: obtiene datos financieros de AccountStatement (1 query) + 3 queries simples de Ticket para premios pagados
- Elimina las 9+ queries con JOINs a Jugada del camino original
- El codigo original se mantiene como fallback para ventanas sin AccountStatement

**Impacto:** `GET /api/v1/ventas/summary` estimado de **3.8s** a **<500ms**.

---

## Parte B: Pendiente para esta noche (requiere migracion)

### B1. Indexes a agregar en `schema.prisma`

#### B1.1 Sorteo: `@@index([status, scheduledAt])`

**Justificacion:** `evaluatedSummary` filtra por `status IN (EVALUATED)` + rango de `scheduledAt`. No existe index compuesto; el planner usa seq scan o `@@index([loteriaId, scheduledAt])` que no cubre `status`.

**Queries que beneficia:**
- `sorteo.service.ts:1587` — findMany sorteos EVALUATED + scheduledAt range
- `sorteo.service.ts:2356` — monthly sorteos query (misma estructura)

```prisma
@@index([status, scheduledAt])
```

---

#### B1.2 Jugada: `@@index([ticketId, deletedAt])`

**Justificacion:** Las queries de jugadas filtran por `ticketId` + `deletedAt IS NULL`. El index actual `@@index([ticketId])` no cubre `deletedAt`, forzando filter scan.

**Queries que beneficia:**
- `sorteo.service.ts:1609` — jugadas del rango
- `sorteo.service.ts:2417` — monthly jugadas

```prisma
@@index([ticketId, deletedAt])
```

---

#### B1.3 Ticket: `@@index([vendedorId, sorteoId, deletedAt, isActive])`

**Justificacion:** Las 4 queries `groupBy` en `evaluatedSummary` filtran TODAS por `{ sorteoId IN, vendedorId, deletedAt: null, isActive: true }`. No hay ningun index que cubra esta combinacion.

**Queries que beneficia (6 queries en `evaluatedSummary`):**
- `sorteo.service.ts:1662` — groupBy financialData
- `sorteo.service.ts:1681` — groupBy prizesData
- `sorteo.service.ts:1696` — groupBy winningTicketsData
- `sorteo.service.ts:1715` — groupBy paidTicketsData
- `sorteo.service.ts:2366` — monthly financialData
- `sorteo.service.ts:2384` — monthly prizesData

```prisma
@@index([vendedorId, sorteoId, deletedAt, isActive])
```

---

#### B1.4 Ticket: `@@index([ventanaId, businessDate, deletedAt])`

**Justificacion:** `venta.service.ts` y `accounts.service.ts` consultan por `ventanaId` + `businessDate` + `deletedAt: null`. El index existente usa `createdAt` en vez de `businessDate`.

**Queries que beneficia:**
- `venta.service.ts` — summary por ventana y fecha
- `accounts.service.ts` — getStatementDirect (fallback)

```prisma
@@index([ventanaId, businessDate, deletedAt])
```

---

#### B1.5 AccountStatement: `@@index([vendedorId, date])`

**Justificacion:** `evaluatedSummary` consulta por `vendedorId` + `date` en multiples puntos. Existen indexes individuales pero no compuesto. PostgreSQL no combina eficientemente dos B-tree individuales para AND.

**Queries que beneficia:**
- `sorteo.service.ts:2113` — findFirst previous day statement
- `sorteo.service.ts:2127` — findFirst last statement before range
- `sorteo.service.ts:2298` — findMany statements for accumulated
- `accounts.service.ts` — queries de balance por vendedor y fecha

```prisma
@@index([vendedorId, date])
```

---

### B2. Pasos de ejecucion

#### Paso 1: Agregar indexes en schema.prisma

**Model Sorteo** (despues de linea 341):
```prisma
  @@index([status, scheduledAt])
```

**Model Jugada** (despues de linea 302):
```prisma
  @@index([ticketId, deletedAt])
```

**Model Ticket** (despues de linea 230):
```prisma
  @@index([vendedorId, sorteoId, deletedAt, isActive])
  @@index([ventanaId, businessDate, deletedAt])
```

**Model AccountStatement** (despues de linea 716):
```prisma
  @@index([vendedorId, date])
```

#### Paso 2: Generar migracion

```bash
npx prisma migrate dev --name add_performance_indexes
```

#### Paso 3: Deploy a produccion

```bash
npx prisma migrate deploy
npx prisma generate
```

#### Paso 4: Verificar

Probar `GET /api/v1/sorteos/evaluated-summary?date=today` y comparar tiempos.

---

### B3. Impacto estimado de indexes

| Query | Antes | Despues estimado |
|-------|-------|------------------|
| Sorteo findMany (status + scheduledAt) | Seq scan ~100ms | Index scan ~5ms |
| Ticket groupBy x4-6 | Seq scan ~200ms c/u | Index scan ~20ms c/u |
| Jugada findMany (JOIN) | Filter scan ~150ms | Index JOIN ~30ms |
| AccountStatement findFirst/Many | 2 index scans ~40ms | 1 index scan ~5ms |
| **Total evaluatedSummary** | **~2-3s** | **~500ms-1s** |

---

## Parte C: Analisis de `evaluated-summary` (referencia futura)

### C1. Queries actuales (17 queries secuenciales)

| # | Query | Linea | Tabla |
|---|-------|-------|-------|
| 1 | findMany sorteos EVALUATED + range | 1587 | Sorteo |
| 2 | findMany jugadas (todas, con JOINs) | 1609 | Jugada |
| 3 | groupBy financialData | 1662 | Ticket |
| 4 | groupBy prizesData | 1681 | Ticket |
| 5 | groupBy winningTicketsData | 1696 | Ticket |
| 6 | groupBy paidTicketsData | 1715 | Ticket |
| 7 | findMovementsByDateRange | 1786 | AccountPayment |
| 8 | getPreviousMonthFinalBalance | 1798 | MonthlyClosingBalance |
| 9 | findFirst previous day statement | 2113 | AccountStatement |
| 10 | findMany statements for accumulated | 2298 | AccountStatement |
| 11 | findMany monthly sorteos (REDUNDANTE) | 2356 | Sorteo |
| 12 | groupBy monthly financial (REDUNDANTE) | 2366 | Ticket |
| 13 | groupBy monthly prizes (REDUNDANTE) | 2384 | Ticket |
| 14 | findMany monthly jugadas (REDUNDANTE) | 2417 | Jugada |
| 15 | findMovementsByDateRange monthly | 2183 | AccountPayment |
| 16 | getPreviousMonthFinalBalance monthly | 2448 | MonthlyClosingBalance |

### C2. Problemas identificados

1. **Queries 11-14 redundantes**: Cuando `date=month` (caso mas comun), recalculan lo mismo que queries 1-6 sin filtro de loteria
2. **Query #2 excesiva**: Carga TODAS las jugadas en memoria (~1,500+ filas/dia) con 3 JOINs, luego las procesa con `.filter()/.reduce()` en bucles O(n*m)
3. **Queries 3-6 secuenciales**: Son independientes entre si, podrian ejecutarse en paralelo con `Promise.all()`

### C3. Optimizaciones futuras (no esta noche)

1. **Eliminar queries monthlyAccumulated redundantes** cuando `date=month` — ahorra 4 queries
2. **Reemplazar jugadas findMany por groupBy** — evita cargar miles de filas en memoria
3. **Usar AccountStatement** para resumen financiero (como en ventas y accounts)
4. **Paralelizar queries independientes** con `Promise.all()` — queries 3-6 y 7-8
5. **Cache Redis** para monthlyAccumulated (cambia poco durante el dia, TTL 5-15 min)

---
---

## Parte D: Plan de Eliminación de Connection Pool Exhaustion

> **Contexto**: La app lanza `Timed out fetching a new connection from the connection pool`
> en Render con Supabase Transaction Pooler (puerto 6543).
>
> **Causa raíz identificada**: combinación de `connection_limit=1` (ya corregido a 10),
> paralelismo sin throttle en servicios críticos, N+1 queries en jobs,
> y queries pesadas con `include` que monopolizan conexiones.
>
> **Fecha de análisis**: 2026-02-15

---

### Fase 0: Config de conexión (YA APLICADO)

| Cambio | Antes | Después | Estado |
|--------|-------|---------|--------|
| `connection_limit` en `DATABASE_URL` | 1 | 10 | ✅ Aplicado en Render |
| `pool_timeout` en `DATABASE_URL` | 10 (default) | 30 | ✅ Aplicado en Render |

> **PENDIENTE**: Si `DIRECT_URL` está configurado, agregar `connection_limit=3` para
> limitar el pool del cliente directo (usado por jobs). Verificar en Render dashboard.

---

### Fase 1: Correcciones quirúrgicas sin migración (bajo riesgo, alto impacto)

Estas son cambios de código puros. No requieren migración de BD.
Se pueden deployar de forma independiente y segura.

---

#### F1.1 — Desconectar `prismaDirect` en graceful shutdown

**Archivo**: `src/server/server.ts`
**Línea**: ~259-270

**Problema**: En el shutdown solo se desconecta `prisma` (pooler), pero `prismaDirect`
(puerto 5432) queda huérfano. En Render, cada redeploy deja una conexión directa
abierta que solo se cierra cuando PgBouncer la mata por timeout (~5 min).

**Cambio**:
```ts
// En gracefulShutdown, ANTES de prisma.$disconnect():
import { getPrismaDirect } from '../core/prismaClientDirect';

// Dentro de server.close callback, antes de prisma.$disconnect():
try {
  // Solo desconectar si fue inicializado (lazy load)
  if ((global as any).__prismaDirect) {
    await getPrismaDirect().$disconnect();
    logger.info({ layer: 'server', action: 'PRISMA_DIRECT_DISCONNECTED' });
  }
} catch (e) {
  logger.warn({
    layer: 'server',
    action: 'PRISMA_DIRECT_DISCONNECT_ERROR',
    meta: { error: (e as Error).message },
  });
}
```

**Riesgo**: Ninguno. Solo afecta el cierre del proceso.

---

#### F1.2 — Throttle en Account Sync (`Promise.allSettled` sin límite)

**Archivo**: `src/api/v1/services/accounts/accounts.sync.service.ts`
**Líneas**: ~848-868 (syncPromises) y ~894-905 (propagationPromises)

**Problema**: Al cerrar un sorteo con 20 vendedores + 5 ventanas + 2 bancas,
se disparan **27 syncs concurrentes** sin límite, cada uno con múltiples queries.
Bajo carga, esto satura el pool de golpe.

**Cambio**: Procesar en batches de 5 usando una función helper (sin dependencias externas):

```ts
/**
 * Ejecuta promesas en batches de tamaño fijo.
 * Equivalente a p-limit pero sin dependencia externa.
 */
async function batchedAllSettled<T>(
  tasks: (() => Promise<T>)[],
  batchSize: number
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(fn => fn()));
    results.push(...batchResults);
  }
  return results;
}
```

Luego reemplazar:
```ts
// ANTES:
const syncPromises: Promise<void>[] = [];
for (const vendedorId of Array.from(uniqueVendedores)) {
  syncPromises.push(this.syncDayStatementFromBySorteo(dateStr, "vendedor", vendedorId));
}
// ... ventanas, bancas ...
const syncResults = await Promise.allSettled(syncPromises);

// DESPUÉS:
const syncTasks: (() => Promise<void>)[] = [];
for (const vendedorId of Array.from(uniqueVendedores)) {
  syncTasks.push(() => this.syncDayStatementFromBySorteo(dateStr, "vendedor", vendedorId));
}
// ... ventanas, bancas (mismo patrón, push de () => ...) ...
const SYNC_BATCH_SIZE = 5;
const syncResults = await batchedAllSettled(syncTasks, SYNC_BATCH_SIZE);
```

Aplicar lo mismo para `propagationPromises` (líneas ~894-905).

**Riesgo**: Bajo. El comportamiento es idéntico, solo se limita la concurrencia.
El `allSettled` sigue ejecutando todos aunque alguno falle.

**Impacto**: Reduce pico de conexiones simultáneas de ~27 a ~5.

---

#### F1.3 — Reducir paralelismo del Dashboard

**Archivo**: `src/api/v1/services/dashboard.service.ts`
**Línea**: ~1559

**Problema**: `getFullDashboard` dispara 7 operaciones en `Promise.all`,
que internamente generan ~10 queries concurrentes. Con múltiples usuarios
abriendo el dashboard, cada uno consume 10 slots del pool simultáneamente.

**Cambio**: Dividir en 2 fases secuenciales (prioridad vs secundario):

```ts
// FASE 1: Datos críticos (los que el usuario ve primero)
const [ganancia, cxc, cxp, summary] = await Promise.all([
  measureAsync('calculateGanancia', () => this.calculateGanancia(filters, role)),
  measureAsync('calculateCxC', () => this.calculateCxC(filters)),
  measureAsync('calculateCxP', () => this.calculateCxP(filters)),
  measureAsync('getSummary', () => this.getSummary(filters, role)),
]);

// FASE 2: Datos complementarios (gráficas, comparativas)
const [timeSeries, exposure, previousPeriod] = await Promise.all([
  measureAsync('getTimeSeries', () => this.getTimeSeries({ ...filters, interval: filters.interval || 'day' })),
  measureAsync('calculateExposure', () => this.calculateExposure(filters)),
  measureAsync('calculatePreviousPeriod', () => this.calculatePreviousPeriod(filters, role)),
]);
```

**Riesgo**: Bajo. Agrega ~50-100ms de latencia total al dashboard pero reduce
el pico de conexiones de ~10 a ~4-5 por request.

**Impacto**: Un request de dashboard pasa de consumir 10 conexiones simultáneas
a un máximo de 4. Con 3 usuarios concurrentes: de 30 conexiones a 12.

---

### Fase 2: Optimización del Settlement Job (riesgo medio)

Estos cambios son más profundos pero el settlement job solo corre 1 vez al día
(3 AM UTC) y puede probarse manualmente con el endpoint de ejecución manual.

---

#### F2.1 — Consolidar los 4 counts diagnósticos en 1 query

**Archivo**: `src/jobs/accountStatementSettlement.job.ts`
**Líneas**: ~184-196

**Problema**: 4 queries `count()` secuenciales antes de empezar el trabajo real.
Ocupan la conexión durante 4 roundtrips innecesarios.

**Cambio**: Reemplazar con 1 `$queryRaw`:

```ts
// ANTES (4 queries):
const totalStatements = await prisma.accountStatement.count();
const settledStatementsCount = await prisma.accountStatement.count({ where: { isSettled: true } });
const notSettledCount = await prisma.accountStatement.count({ where: { isSettled: false } });
const notSettledOldEnoughCount = await prisma.accountStatement.count({
  where: { isSettled: false, date: { lt: cutoffDateCR } }
});

// DESPUÉS (1 query):
const [diagnostics] = await prisma.$queryRaw<[{
  total: number;
  settled: number;
  not_settled: number;
  not_settled_old_enough: number;
}]>`
  SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE "isSettled" = true)::int AS settled,
    COUNT(*) FILTER (WHERE "isSettled" = false)::int AS not_settled,
    COUNT(*) FILTER (WHERE "isSettled" = false AND "date" < ${cutoffDateCR})::int AS not_settled_old_enough
  FROM "AccountStatement"
`;
```

**Riesgo**: Bajo. Es un reemplazo directo de reads diagnósticos.

---

#### F2.2 — Eliminar `include: { payments }` del findMany de settlement

**Archivo**: `src/jobs/accountStatementSettlement.job.ts`
**Líneas**: ~220-238

**Problema**: Carga hasta 2000 statements con TODOS sus payments embebidos.
Con 10 payments por statement = 20,000 objetos. La conexión queda bloqueada
durante el fetch y la serialización.

**Cambio**: Reemplazar el `include` + `reduce` por un aggregate separado:

```ts
// ANTES:
const statementsToSettle = await prisma.accountStatement.findMany({
  where: { isSettled: false, date: { lt: cutoffDateCR } },
  include: { payments: { where: { isReversed: false } } },
  orderBy: { date: 'asc' },
  take: safeBatchSize,
});
// ... luego en el for loop:
const totalPaid = statement.payments.filter(p => p.type === 'payment').reduce(...);

// DESPUÉS:
const statementsToSettle = await prisma.accountStatement.findMany({
  where: { isSettled: false, date: { lt: cutoffDateCR } },
  orderBy: { date: 'asc' },
  take: safeBatchSize,
  // SIN include de payments
});

// Pre-calcular totales de payments en 1 sola query con groupBy:
const statementIds = statementsToSettle.map(s => s.id);
const paymentTotals = await prisma.accountPayment.groupBy({
  by: ['accountStatementId', 'type'],
  where: {
    accountStatementId: { in: statementIds },
    isReversed: false,
  },
  _sum: { amount: true },
});

// Construir mapa de totales:
const totalsMap = new Map<string, { totalPaid: number; totalCollected: number }>();
for (const row of paymentTotals) {
  const entry = totalsMap.get(row.accountStatementId) || { totalPaid: 0, totalCollected: 0 };
  if (row.type === 'payment') entry.totalPaid = row._sum.amount || 0;
  if (row.type === 'collection') entry.totalCollected = row._sum.amount || 0;
  totalsMap.set(row.accountStatementId, entry);
}

// En el for loop usar:
const totals = totalsMap.get(statement.id) || { totalPaid: 0, totalCollected: 0 };
```

**Riesgo**: Medio. Cambia la lógica de cálculo de totales. Verificar con ejecución manual
comparando resultados antes/después en staging.

**Impacto**: Reduce drásticamente el payload del findMany y la duración de la conexión.

---

#### F2.3 — Eliminar N+1 en Carry Forward (triple loop)

**Archivo**: `src/jobs/accountStatementSettlement.job.ts`
**Líneas**: ~402-635

**Problema**: Para cada entidad (banca, ventana, vendedor) hace:
1. `findFirst` para verificar si ya existe statement hoy
2. `findFirst` para obtener el último statement anterior
3. `create` si hay saldo que arrastrar

Con 50 vendedores + 10 ventanas + 3 bancas = ~190 queries secuenciales.

**Cambio**: Pre-cargar existencia y últimos saldos en batch:

```ts
// 1. Cargar TODOS los statements de hoy en una sola query:
const existingToday = await prisma.accountStatement.findMany({
  where: { date: todayCR },
  select: { bancaId: true, ventanaId: true, vendedorId: true },
});
const todaySet = new Set(
  existingToday.map(s => `${s.bancaId || ''}|${s.ventanaId || ''}|${s.vendedorId || ''}`)
);

// 2. Cargar TODOS los últimos statements con saldo != 0 (por dimensión)
// Para bancas consolidadas (ventanaId IS NULL, vendedorId IS NULL):
const latestBancaStatements = await prisma.$queryRaw<Array<{
  banca_id: string;
  remaining_balance: number;
  accumulated_balance: number;
}>>`
  SELECT DISTINCT ON ("bancaId")
    "bancaId" as banca_id,
    "remainingBalance" as remaining_balance,
    COALESCE("accumulatedBalance", "remainingBalance") as accumulated_balance
  FROM "AccountStatement"
  WHERE "ventanaId" IS NULL AND "vendedorId" IS NULL
    AND "date" < ${todayCR}
    AND "remainingBalance" != 0
    AND "bancaId" = ANY(${activeBancas.map(b => b.id)}::uuid[])
  ORDER BY "bancaId", "date" DESC
`;

// Queries similares para ventanas y vendedores...

// 3. Construir inserts en batch:
const toCreate = [];
for (const banca of activeBancas) {
  const key = `${banca.id}||`;
  if (todaySet.has(key)) continue;
  const latest = latestBancaMap.get(banca.id);
  if (!latest || latest.remaining_balance === 0) continue;
  toCreate.push({ /* datos del statement */ });
}
// ... ventanas, vendedores ...

// 4. Insertar todo de una vez con createMany + skipDuplicates:
if (toCreate.length > 0) {
  const result = await prisma.accountStatement.createMany({
    data: toCreate,
    skipDuplicates: true, // Maneja race conditions sin try/catch
  });
  carryForwardCreated = result.count;
}
```

**Riesgo**: Medio-Alto. Cambia la lógica de carry forward.
Requiere testing exhaustivo con ejecución manual antes de ir a producción.

**Impacto**: De ~190 queries secuenciales a ~4-5 queries batch.

---

### Fase 3: Mejoras complementarias (bajo riesgo, bajo impacto)

---

#### F3.1 — Warmup: Verificar el pooler correcto

**Archivo**: `src/jobs/sorteosAuto.job.ts`
**Líneas**: ~63, ~121, ~324

**Problema**: Los jobs llaman `warmupConnection({ useDirect: true })` que verifica
la conexión del cliente directo (puerto 5432), pero luego ejecutan queries
con `prisma` (pooler transaccional, puerto 6543). El warmup no verifica
el canal correcto.

**Cambio**: Usar `useDirect: false` (o eliminar el parámetro):
```ts
// ANTES:
const isReady = await warmupConnection({ useDirect: true, context: 'autoOpen' });

// DESPUÉS:
const isReady = await warmupConnection({ useDirect: false, context: 'autoOpen' });
```

**Riesgo**: Ninguno.

---

#### F3.2 — Agregar `DIRECT_URL` con `connection_limit=3`

**Archivo**: Variables de entorno en Render

**Problema**: Si `DIRECT_URL` está configurado (puerto 5432), el cliente directo
usa pool por defecto de Prisma (~10 conexiones). Innecesario para jobs.

**Cambio**: En Render, agregar `connection_limit=3` al final del `DIRECT_URL`:
```
postgresql://...@host.supabase.co:5432/postgres?connection_limit=3
```

**Riesgo**: Ninguno.

---

### Resumen de fases y prioridad de ejecución

| Fase | Cambio | Archivos | Riesgo | Impacto en pool |
|------|--------|----------|--------|-----------------|
| ~~0~~ | ~~connection_limit=10~~ | ~~Render env~~ | — | ~~✅ Ya aplicado~~ |
| 1.1 | Disconnect prismaDirect en shutdown | server.ts | Ninguno | Previene conexiones huérfanas |
| 1.2 | Throttle account sync (batch de 5) | accounts.sync.service.ts | Bajo | Pico 27→5 conexiones |
| 1.3 | Reducir paralelismo dashboard (2 fases) | dashboard.service.ts | Bajo | Pico 10→4-5 por request |
| 2.1 | Consolidar 4 counts en 1 query raw | settlement.job.ts | Bajo | -3 roundtrips |
| 2.2 | Eliminar include payments por groupBy | settlement.job.ts | Medio | -20K objetos en memoria |
| 2.3 | Batch carry forward (N+1 → batch) | settlement.job.ts | Medio-Alto | 190→5 queries |
| 3.1 | Warmup: usar pooler en vez de direct | sorteosAuto.job.ts | Ninguno | -1 conexión innecesaria |
| 3.2 | DIRECT_URL connection_limit=3 | Render env | Ninguno | Limita pool directo |

> **Orden recomendado de deploy**:
> 1. Fase 1 completa (1.1 + 1.2 + 1.3) en un solo deploy — son cambios independientes y de bajo riesgo
> 2. Fase 2.1 y 2.2 juntos — se pueden verificar con ejecución manual del settlement
> 3. Fase 2.3 por separado — requiere más testing
> 4. Fase 3 cuando sea conveniente — sin urgencia
