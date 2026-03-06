# OPTIMIZACIÓN ACCOUNTS — Plan de corrección validado
> Fecha de análisis: 2026-02-26
> Estado: **Pendiente de aprobación** — No implementar sin confirmación explícita.

---

## 1. Resumen ejecutivo de validación

| # | Propuesta | Veredicto | Prioridad |
|---|-----------|-----------|-----------|
| 1.1 | Fallback de saldo entre dimensiones | **YA IMPLEMENTADO** — código en 2173–2233 | — |
| 1.2 | `findOrCreate` transaccional (Serializable) | **NO NECESARIO** — P2002+culprit-cleaning funciona; upsert perdería lógica crítica | — |
| 1.3 | Centralizar filtros de movimientos | **YA IMPLEMENTADO** en el repositorio — `findMovementsByDateRange` filtra por dimensión y excluye sintéticos en líneas 522–526, 534–535, 464 | — |
| 2.1 | Paralelizar `propagateBalanceChange` | **RECHAZADO — PELIGROSO** — rompería el acumulado progresivo | — |
| 2.2 | Cache de nombres en exportaciones | No necesario — queries ya son batch con `findMany` + `IN` | — |
| 2.3 | Worker Threads en reduce mensual | **RECHAZADO** — premature optimization; el reduce es en memoria | — |
| 3.1 | Guardia NaN/Infinity en acumulados | Válido como práctica defensiva opcional | MUY BAJA |
| 3.2 | Jitter en `batchedAllSettled` | Diferir; no hay evidencia de necesidad | — |
| N/A | `getPreviousMonthFinalBalancesBatch` secuencial | **ÚNICO CAMBIO RECOMENDADO** — loop secuencial N queries en serie → `Promise.all` | BAJA |

---

## 2. Análisis detallado por propuesta

### 1.1 — Contaminación de saldos entre dimensiones

**Veredicto: YA IMPLEMENTADO — no requiere cambios.**

El código en [accounts.calculations.ts:2173-2181](src/api/v1/services/accounts/accounts.calculations.ts#L2173-L2181) ya construye `targetVendedorId` priorizando el `vendedorId` del filtro (no del `entry`), y en [accounts.calculations.ts:2227-2233](src/api/v1/services/accounts/accounts.calculations.ts#L2227-L2233) tiene el guard explícito:

```typescript
// YA EXISTE — líneas 2227-2233
if (dimension === "vendedor" && targetVendedorId && previousDayRemainingBalance === null) {
    // Si no encontramos statement del vendedor, usar el saldo del mes anterior
    // Esto evita usar el saldo de la ventana por error
    previousDayRemainingBalance = Number(previousMonthBalance);
}
```

`previousMonthBalance` proviene de `getPreviousMonthFinalBalance` (accounts.balances.ts:144) que, cuando `dimension === "vendedor"`, usa `vendedorId` en el where de Prisma, no `ventanaId`. La cadena es dimension-safe.

---

### 1.2 — Race condition en `findOrCreate`

**Veredicto: Race condition real, pero la solución propuesta es regresiva.**

**El problema real** (accountStatement.repository.ts:65–169): entre el `findFirst` (línea 65) y el `create` (línea 81) existe una ventana de concurrencia. Bajo carga alta, dos procesos podrían intentar crear el mismo registro simultáneamente.

**Por qué la propuesta falla:** La solución propuesta usa `$transaction(Serializable)` + `findFirst` + `create`, pero **pierde completamente la lógica de "culprit-cleaning"** (líneas 111–150), que limpia registros sucios (`vendedorId NOT NULL` bloqueando un consolidado de ventana). Ese código resuelve un problema real de integridad de datos histórica que el upsert simple no maneja.

**Problema adicional con la propuesta de upsert:** El comentario en la línea 8 del repositorio explica por qué no se usa `upsert()`: incompatibilidad con el naming de constraints compuestos en Prisma.

**Valoración del estado actual:** El patrón reactivo (P2002 → retry → culprit search) funciona correctamente en producción. La concurrencia es manejada y el culprit-cleaning es valioso. No se recomienda cambio urgente.

**Alternativa real si se quisiera mejorar:** Advisory locks de PostgreSQL (`pg_try_advisory_xact_lock`) preservando toda la lógica existente — pero esto requeriría `$queryRaw` y complejidad significativa.

---

### 1.3 — Inconsistencia en filtros de movimientos en el loop mensual

**Veredicto: VÁLIDO — hay una inconsistencia confirmada y un riesgo defensivo.**

**Problema A — Filtro de dimensión ausente en loop mensual:**

El loop mensual en [accounts.calculations.ts:3431-3439](src/api/v1/services/accounts/accounts.calculations.ts#L3431-L3439) solo filtra por `bancaId` cuando `dimension === "banca"`, pero no aplica filtros equivalentes para `ventana` ni `vendedor`:

```typescript
// ESTADO ACTUAL (líneas 3431-3439) — falta filtro dimension ventana/vendedor
for (const movements of monthlyMovementsByDate.values()) {
    let filteredMovements = movements;
    if (dimension === "banca" && bancaId) {
        filteredMovements = movements.filter((m: any) => m.bancaId === bancaId);
    }
    // ❌ Sin filtro vendedorId = null para ventana
    // ❌ Sin filtro vendedorId === vendedorId para vendedor
    monthlyTotalPaid += filteredMovements
        .filter((m: any) => m.type === "payment" && !m.isReversed)
        ...
```

Esto es inconsistente con el filtro centralizado en [accounts.movements.ts:1871-1894](src/api/v1/services/accounts/accounts.movements.ts#L1871-L1894) que sí aplica los tres casos. Si `AccountPaymentRepository.findMovementsByDateRange` ya devuelve solo los movimientos filtrados por dimensión, el impacto actual es nulo; pero si devuelve un conjunto más amplio y delega al caller, hay doble-conteo potencial.

**Problema B — Sin guardia de movimiento sintético:**

El mismo loop (líneas 3435–3438) no tiene el filtro `previous-month-balance-`. Aunque `monthlyMovementsByDate` proviene de una query a DB (no debería contener sintéticos), agregar la guardia es práctica defensiva para prevenir regresiones del tipo del bug de febrero 2026.

---

### 2.1 — Paralelizar `propagateBalanceChange`

**Veredicto: RECHAZADO — rompería la integridad de acumulados.**

El loop secuencial en [accounts.sync.service.ts:1289-1305](src/api/v1/services/accounts/accounts.sync.service.ts#L1289-L1305) es **intencional y correcto**. Cada día depende del `accumulatedBalance` del día anterior:

```
accumulatedBalance(día N) = accumulatedBalance(día N-1) + balance(N) + pagos(N)
```

Paralelizar (incluso por batches) significaría que el Día 3 correría antes de que el Día 2 haya persistido su `accumulatedBalance`, usando un valor obsoleto. Esto corrompería silenciosamente todos los saldos acumulados de la entidad afectada.

El `batchedAllSettled` existente es correcto para entidades **independientes entre sí** (e.g., sync de múltiples vendedores en paralelo), **no** para días de la misma entidad.

---

### 2.2 — Cache de nombres en exportaciones

**Veredicto: Impacto bajo. El patrón batch ya es eficiente.**

Las exportaciones ya usan `findMany` con `IN` (ver [accounts-export.service.ts:268-291](src/api/v1/services/accounts-export.service.ts#L268-L291)), que es una sola query. Un cache en memoria agregaría complejidad (invalidación, gestión de memoria) sin beneficio significativo para el volumen típico de estas operaciones.

Aplazar para cuando haya evidencia de contención en producción.

---

### 2.3 — Paralelizar reduce mensual (Worker Threads)

**Veredicto: RECHAZADO — over-engineering incorrecto.**

El `Array.from(monthlyByDateAndDimension.values()).reduce(...)` en [accounts.calculations.ts:3418-3428](src/api/v1/services/accounts/accounts.calculations.ts#L3418-L3428) opera sobre un `Map` en memoria. Para cualquier volumen realista de datos de un mes (días × entidades), este reduce completa en microsegundos. El overhead de crear/comunicar Worker Threads (decenas de ms + serialización) sería órdenes de magnitud mayor que la operación misma.

---

### 3.1 — Validación de invariantes en acumulados

**Veredicto: VÁLIDO — guardia defensiva antes de persistir.**

Agregar validación `isNaN/!isFinite` antes de escribir `accumulatedBalance` en la DB previene propagar valores corruptos. Útil como red de seguridad para detectar errores de cálculo temprano.

---

### N/A — `getPreviousMonthFinalBalancesBatch` secuencial (hallazgo nuevo)

**Veredicto: BUG DE RENDIMIENTO confirmado.**

En [accounts.balances.ts:232-239](src/api/v1/services/accounts/accounts.balances.ts#L232-L239) el batch procesa cada entidad secuencialmente con `await` dentro de un `for`:

```typescript
// ESTADO ACTUAL — secuencial
for (const entityId of entityIds) {
    const balance = await getPreviousMonthFinalBalance(...);
    balancesMap.set(entityId, balance);
}
```

Cada `getPreviousMonthFinalBalance` hace al menos una query a DB. Para una ventana con 10 vendedores, esto son 10 queries en serie. El fix es trivial y de alto impacto relativo al esfuerzo.

---

## 3. Cambios puntuales recomendados

### C1 — Filtros de dimensión en loop mensual de pagos/cobros
**Prioridad: MEDIA | Riesgo: BAJO | Impacto: PREVENTIVO**

**Archivo:** [src/api/v1/services/accounts/accounts.calculations.ts](src/api/v1/services/accounts/accounts.calculations.ts)
**Líneas:** 3431–3439

```typescript
// ANTES (líneas 3431-3439)
for (const movements of monthlyMovementsByDate.values()) {
    let filteredMovements = movements;
    if (dimension === "banca" && bancaId) {
        filteredMovements = movements.filter((m: any) => m.bancaId === bancaId);
    }
    monthlyTotalPaid += filteredMovements
        .filter((m: any) => m.type === "payment" && !m.isReversed)
        .reduce((sum: number, m: any) => sum + m.amount, 0);
    monthlyTotalCollected += filteredMovements
        .filter((m: any) => m.type === "collection" && !m.isReversed)
        .reduce((sum: number, m: any) => sum + m.amount, 0);
}
```

```typescript
// DESPUÉS
for (const movements of monthlyMovementsByDate.values()) {
    let filteredMovements = movements;
    if (dimension === "banca" && bancaId) {
        filteredMovements = movements.filter((m: any) => m.bancaId === bancaId);
    } else if (dimension === "ventana" && ventanaId) {
        // Solo movimientos consolidados de la ventana (sin vendedor)
        filteredMovements = movements.filter((m: any) =>
            m.ventanaId === ventanaId && (m.vendedorId === null || m.vendedorId === undefined)
        );
    } else if (dimension === "vendedor" && vendedorId) {
        filteredMovements = movements.filter((m: any) => m.vendedorId === vendedorId);
    }
    monthlyTotalPaid += filteredMovements
        .filter((m: any) =>
            m.type === "payment" &&
            !m.isReversed &&
            !m.id?.startsWith('previous-month-balance-')  // guardia defensiva
        )
        .reduce((sum: number, m: any) => sum + m.amount, 0);
    monthlyTotalCollected += filteredMovements
        .filter((m: any) =>
            m.type === "collection" &&
            !m.isReversed &&
            !m.id?.startsWith('previous-month-balance-')  // guardia defensiva
        )
        .reduce((sum: number, m: any) => sum + m.amount, 0);
}
```

> **Prerequisito:** Verificar primero si `AccountPaymentRepository.findMovementsByDateRange` ya filtra por `dimension + entityId`. Si ya lo hace, los filtros de ventana/vendedor son redundantes pero no dañinos. Si NO lo hace, son necesarios para correctitud.

---

### C2 — Paralelizar `getPreviousMonthFinalBalancesBatch`
**Prioridad: MEDIA | Riesgo: MUY BAJO | Impacto: RENDIMIENTO**

**Archivo:** [src/api/v1/services/accounts/accounts.balances.ts](src/api/v1/services/accounts/accounts.balances.ts)
**Líneas:** 232–239

```typescript
// ANTES (líneas 232-239) — secuencial: N queries en serie
for (const entityId of entityIds) {
    const balance = await getPreviousMonthFinalBalance(
        effectiveMonth,
        dimension,
        dimension === "ventana" ? entityId : null,
        dimension === "vendedor" ? entityId : null,
        bancaId
    );
    balancesMap.set(entityId, balance);
}
```

```typescript
// DESPUÉS — paralelo: N queries simultáneas
await Promise.all(
    entityIds.map(async (entityId) => {
        const balance = await getPreviousMonthFinalBalance(
            effectiveMonth,
            dimension,
            dimension === "ventana" ? entityId : null,
            dimension === "vendedor" ? entityId : null,
            bancaId
        );
        balancesMap.set(entityId, balance);
    })
);
```

> **Nota:** `Map.set` en JavaScript es sincrónico y seguro ante concurrencia de microtareas (no hay race condition aquí). `getPreviousMonthFinalBalance` ya tiene su propio cache por entidad.

---

### C3 — Guardia NaN/Infinity antes de persistir `accumulatedBalance`
**Prioridad: BAJA | Riesgo: MUY BAJO | Impacto: DETECCIÓN TEMPRANA**

**Archivo:** [src/api/v1/services/accounts/accounts.sync.service.ts](src/api/v1/services/accounts/accounts.sync.service.ts)
**Ubicación:** Inmediatamente antes de cualquier `prisma.accountStatement.update({ data: { accumulatedBalance: ... } })`

```typescript
// AGREGAR como helper en accounts.sync.service.ts
function assertValidAccumulated(
    value: number,
    context: { date: string; dimension: string; entityId?: string }
): void {
    if (!isFinite(value) || isNaN(value)) {
        throw new AppError(
            `Accumulated balance inválido (${value}) para ${context.dimension}/${context.entityId} en ${context.date}`,
            500,
            { meta: context }
        );
    }
}

// USO antes de cada update:
assertValidAccumulated(calculatedAccumulated, { date: dateStr, dimension, entityId });
await prisma.accountStatement.update({
    where: { id: statementId },
    data: { accumulatedBalance: calculatedAccumulated }
});
```

---

## 4. Plan de implementación

### Fase 1 — Correcciones defensivas (sin riesgo de regresión)
> Puede implementarse en cualquier momento. No cambia lógica, solo agrega filtros/guardias.

| Cambio | Archivo | Líneas | Acción |
|--------|---------|--------|--------|
| C1 — Filtros dimensión + guardia sintético en loop mensual | accounts.calculations.ts | 3431–3439 | **Verificar** si repo ya filtra → luego aplicar |
| C3 — Guardia NaN/Infinity | accounts.sync.service.ts | Antes de cada update | Agregar helper + llamadas |

**Prerequisito C1:** Antes de implementar los filtros de ventana/vendedor en el loop, ejecutar:
```bash
npx tsx -e "
const repo = require('./src/repositories/accountPayment.repository');
// Inspeccionar firma de findMovementsByDateRange para confirmar si ya filtra por entityId
"
```
O leer directamente: [src/repositories/accountPayment.repository.ts](src/repositories/accountPayment.repository.ts) — buscar `findMovementsByDateRange`.

---

### Fase 2 — Mejora de rendimiento
> Implementar tras verificar en staging. Bajo riesgo, alto impacto.

| Cambio | Archivo | Líneas | Acción |
|--------|---------|--------|--------|
| C2 — Paralelizar batch de saldos anteriores | accounts.balances.ts | 232–239 | Reemplazar loop por `Promise.all` |

---

### Fase 3 — Mejoras opcionales (diferibles)
> Aplazar hasta que haya evidencia de necesidad en producción.

- Cache de nombres en exportaciones (Propuesta 2.2)
- Jitter en `batchedAllSettled` (Propuesta 3.2)

---

### Cambios que NO se implementarán

| Propuesta | Razón |
|-----------|-------|
| Paralelizar `propagateBalanceChange` (2.1) | Rompería acumulados progresivos — los días son dependientes entre sí |
| Worker Threads en reduce mensual (2.3) | El reduce es en memoria, overhead de threads sería mayor que la operación |
| Reescribir `findOrCreate` con Serializable (1.2) | Perdería la lógica de culprit-cleaning; el estado actual funciona correctamente |

---

## 5. Checklist de implementación

### Pre-implementación
- [ ] Leer `AccountPaymentRepository.findMovementsByDateRange` para confirmar si ya filtra por `dimension + entityId` (determinante para C1)
- [ ] Crear rama `fix/accounts-monthly-filters` desde `master`
- [ ] Tomar snapshot de balances de 3–5 entidades conocidas como baseline para comparación post-deploy

### Fase 1
- [ ] Implementar **C1** en accounts.calculations.ts líneas 3431–3439
  - [ ] Aplicar filtro `ventana` si el repo NO ya filtra
  - [ ] Aplicar filtro `vendedor` si el repo NO ya filtra
  - [ ] Agregar guardia `previous-month-balance-` en ambos filtros (`.type === "payment"` y `.type === "collection"`)
- [ ] Implementar **C3**: agregar helper `assertValidAccumulated` en accounts.sync.service.ts
- [ ] Ejecutar tests unitarios existentes
- [ ] Validar manualmente con request de `/bySorteo?date=month` en staging para vendedor, ventana y banca
- [ ] Comparar totales `monthlyTotalPaid` y `monthlyTotalCollected` contra baseline

### Fase 2
- [ ] Implementar **C2** en accounts.balances.ts líneas 232–239
- [ ] Medir tiempo de respuesta de endpoint que llama a `getPreviousMonthFinalBalancesBatch` antes y después
- [ ] Verificar que `Map.set` produce los mismos resultados que el loop secuencial (comparar maps con mismas IDs)

### Post-deploy Fase 1+2
- [ ] Monitorear logs de Sentry por 48h buscando `AppError` con código 500 de `assertValidAccumulated`
- [ ] Confirmar 0 errores P2002 en `accountStatement.repository.ts` (no debería cambiar, pero verificar)
- [ ] Comparar `accumulatedBalance` del último día del mes en producción con baseline tomado antes

### Criterios de rollback
- Si aparecen diferencias en `monthlyTotalPaid` o `monthlyTotalCollected` > 0.01 respecto al baseline: revertir C1
- Si aparecen errores `assertValidAccumulated` en Sentry: investigar antes de revertir (el error es señal de bug preexistente)
- Si `getPreviousMonthFinalBalancesBatch` produce resultados distintos con C2: revertir al loop secuencial

---

## 6. Métricas de éxito revisadas

| Métrica | Meta | Medición |
|---------|------|----------|
| Correctitud C1 | `monthlyTotalPaid/Collected` igual antes y después del cambio | Comparar en staging con datos reales |
| Rendimiento C2 | Latencia de `getPreviousMonthFinalBalancesBatch` < 50% del valor actual | Logs de `PROPAGATE_BALANCE_CHANGE_START` → `COMPLETED` |
| Estabilidad general | 0 errores P2002 en 30 días | Sentry |
| Detección de bugs C3 | Al menos 1 `assertValidAccumulated` capturado en staging (si hay datos corruptos) | Sentry |

---

## Apéndice: Propuestas ya implementadas (no requieren acción)

### 1.1 — Aislamiento de dimensión vendedor en fallback de saldo
Código existente en [accounts.calculations.ts:2173-2181](src/api/v1/services/accounts/accounts.calculations.ts#L2173-L2181) y [accounts.calculations.ts:2227-2233](src/api/v1/services/accounts/accounts.calculations.ts#L2227-L2233):

```typescript
// Ya existe — dimension=vendedor usa solo vendedorId en lookup
} else if (dimension === "vendedor") {
    targetBancaId = entry.bancaId || undefined;
    targetVentanaId = entry.ventanaId || undefined;
    // CRÍTICO: Priorizar vendedorId del filtro sobre entry.vendedorId
    targetVendedorId = vendedorId || undefined;
}
// ...
if (dimension === "vendedor" && targetVendedorId && previousDayRemainingBalance === null) {
    // NO usar el de la ventana. En su lugar, usar el saldo del mes anterior
    previousDayRemainingBalance = Number(previousMonthBalance);
}
```

`getPreviousMonthFinalBalance` (accounts.balances.ts:168-172) también maneja correctamente esta dimensión con `where.vendedorId = vendedorId`.

### Triple guardia de movimiento sintético
Ya implementada en [accounts.movements.ts:1875-1884](src/api/v1/services/accounts/accounts.movements.ts#L1875-L1884) para el flujo de cálculo diario. El bug de febrero 2026 (sorteo.service.ts) fue corregido. Lo que falta es el backport defensivo al loop mensual (C1 arriba).
