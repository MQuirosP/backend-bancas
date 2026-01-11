# 📊 REVISIÓN DE RENDIMIENTO Y MEMORY LEAKS - BACKEND BANCAS

**Fecha:** 2026-01-10
**Analista:** Senior Backend Engineer
**Stack:** Node.js + TypeScript + Express + Prisma + PostgreSQL
**Infraestructura:** Render

---

## 🎯 RESUMEN EJECUTIVO

Se identificaron **7 problemas CRÍTICOS** y **5 problemas ALTOS** que están causando crecimiento sostenido de memoria en producción. Los hallazgos principales son:

1. **Cron jobs duplicados** por inicialización múltiple de timers
2. **Caché en memoria sin límites** (Maps que crecen infinitamente)
3. **setInterval perpetuo** en archivos importados globalmente
4. **Queries sin paginación** que pueden retornar miles de registros
5. **Dependencias cíclicas** en el sistema de caché V2
6. **Event listeners** acumulándose en Redis client

**Impacto estimado:** El servidor puede experimentar crecimiento de memoria de ~50-100MB por día en tráfico moderado, eventualmente causando OOM (Out of Memory) crashes.

---

## 🔴 PROBLEMAS CRÍTICOS

### 1. CRON JOBS: Duplicación de Timers en Sorteos Auto

**🔴 Problema:**
Los jobs de sorteos automáticos utilizan un patrón de `setTimeout` + `setInterval` que puede crear múltiples timers si `startSorteosAutoJobs()` se llama más de una vez.

**📍 Ubicación:**
[src/jobs/sorteosAuto.job.ts:161-165](src/jobs/sorteosAuto.job.ts#L161-L165)
[src/jobs/sorteosAuto.job.ts:190-194](src/jobs/sorteosAuto.job.ts#L190-L194)

**🧠 Por qué es peligroso:**

```typescript
// LÍNEA 161-165: Auto Open Job
openTimer = setTimeout(() => {
    executeAutoOpen();
    // PROBLEMA: setInterval dentro de setTimeout
    openTimer = setInterval(executeAutoOpen, 24 * 60 * 60 * 1000);
}, delayMs);

// LÍNEA 190-194: Auto Create Job
createTimer = setTimeout(() => {
    executeAutoCreate();
    // PROBLEMA: setInterval dentro de setTimeout
    createTimer = setInterval(executeAutoCreate, 24 * 60 * 60 * 1000);
}, delayMs);
```

**Riesgos:**

- El `setTimeout` inicial se ejecuta y crea un `setInterval`
- Si hay un hot-reload en desarrollo o reinicio parcial, se pierde la referencia al interval interno
- `clearInterval(openTimer)` solo limpia el timer externo, NO el interval creado dentro del callback
- Cada reinicio/reload acumula un nuevo interval ejecutándose cada 24h

**📈 Impacto esperado:**

- Crecimiento lineal: cada reinicio += 1 job duplicado
- En 30 días con 5 reinicios → 5 jobs ejecutándose simultáneamente
- Queries duplicadas a la DB, logs duplicados, posible corrupción de datos

**✅ Recomendación:**

```typescript
// SOLUCIÓN: Usar solo setInterval con cálculo inicial del delay
function scheduleAutoOpen(): void {
  if (openTimer) {
    clearInterval(openTimer); // Limpiar cualquier timer previo
  }

  // Calcular delay hasta próxima ejecución
  const delayMs = getMillisecondsUntilNextRun(7, 0);

  // Ejecutar inmediatamente la primera vez
  setTimeout(() => {
    executeAutoOpen();
  }, delayMs);

  // Programar repetición FUERA del setTimeout
  const intervalMs = 24 * 60 * 60 * 1000;
  openTimer = setInterval(executeAutoOpen, intervalMs);
}
```

**⭐ Prioridad:** CRÍTICO

---

### 2. CRON JOBS: Cierre Automático Ejecuta en Loop Infinito

**🔴 Problema:**
El job de cierre automático (`startAutoCloseJob`) ejecuta inmediatamente al iniciar y luego cada 10 minutos, sin verificar si ya hay un timer ejecutándose.

**📍 Ubicación:**
[src/jobs/sorteosAuto.job.ts:310-328](src/jobs/sorteosAuto.job.ts#L310-L328)

**🧠 Por qué es peligroso:**

```typescript
function startAutoCloseJob(): void {
  if (closeTimer) {
    clearInterval(closeTimer); // ❌ SOLO limpia el timer
  }

  // ⚠️ Ejecuta inmediatamente
  executeAutoClose();

  // ⚠️ Crea nuevo interval (cada 10 minutos)
  closeTimer = setInterval(executeAutoClose, 10 * 60 * 1000);
}
```

**Riesgos:**

- Si `startSorteosAutoJobs()` se llama múltiples veces (tests, hot-reload, etc.), se crean múltiples intervals
- Cada interval ejecuta `executeAutoClose()` cada 10 minutos
- Queries duplicadas, log spam, posible race condition en cierre de sorteos

**📈 Impacto esperado:**

- 144 ejecuciones/día normales (cada 10 min)
- Con 3 reinicios → 432 ejecuciones/día (3x overhead)
- Alto uso de CPU y DB por queries duplicadas

**✅ Recomendación:**

```typescript
function startAutoCloseJob(): void {
  // Verificar si ya hay un timer activo
  if (closeTimer) {
    logger.warn({
      layer: 'job',
      action: 'AUTO_CLOSE_ALREADY_RUNNING',
      payload: { message: 'Auto close job already running, skipping initialization' }
    });
    return; // ← CRÍTICO: No crear timer duplicado
  }

  logger.info({
    layer: 'job',
    action: 'SORTEOS_AUTO_CLOSE_SCHEDULED',
    payload: {
      interval: '10 minutes',
      message: 'Iniciando job de cierre automático',
    },
  });

  // Ejecutar inmediatamente
  executeAutoClose();

  // Programar repeticiones
  closeTimer = setInterval(executeAutoClose, 10 * 60 * 1000);
}
```

**⭐ Prioridad:** CRÍTICO

---

### 3. CACHÉ EN MEMORIA: Map sin Límite de Tamaño en sorteoCache

**🔴 Problema:**
El caché de sorteos (`sorteoCache.ts`) usa un `Map` global sin límite de tamaño ni limpieza proactiva.

**📍 Ubicación:**
[src/utils/sorteoCache.ts:14](src/utils/sorteoCache.ts#L14)

**🧠 Por qué es peligroso:**

```typescript
// LÍNEA 14: Map global sin límite
const sorteoListCache = new Map<string, CachedSorteoList>();

// LÍNEA 186-188: Cleanup solo cada 5 minutos
if (typeof setInterval !== 'undefined') {
  setInterval(cleanupExpiredSorteoCache, 5 * 60 * 1000);
}
```

**Riesgos:**

- Cada combinación de filtros genera una clave única:

  ``` typescript
  sorteos:loteriaId:page:pageSize:status:search:isActive:dateFrom:dateTo:groupBy
  ```

- Con paginación (10 páginas) × 5 loterias × 3 estados × 2 fechas = **300 entradas únicas**
- Cada entrada puede contener arrays grandes de sorteos con relaciones anidadas
- TTL de 30 segundos significa que entradas expiran pero **NO se borran automáticamente**
- Cleanup cada 5 minutos es insuficiente para tráfico alto

**📈 Impacto esperado:**

- Tráfico moderado (1000 req/día): ~500 claves únicas guardadas
- Tamaño promedio por entrada: 5-50KB (depende de relaciones incluidas)
- Memoria estimada: **25-250MB** solo para sorteo cache
- Crecimiento: +5-10MB por día sin reinicio

**✅ Recomendación:**

```typescript
// OPCIÓN 1: Usar LRU Cache con límite de tamaño
import LRU from 'lru-cache';

const sorteoListCache = new LRU<string, CachedSorteoList>({
  max: 500, // Máximo 500 entradas
  maxSize: 50 * 1024 * 1024, // Máximo 50MB
  sizeCalculation: (value) => {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  },
  ttl: 30 * 1000, // 30 segundos
  updateAgeOnGet: true, // LRU behavior
});

// OPCIÓN 2: Migrar a Redis (ya existe CacheService)
// Eliminar el Map en memoria y usar solo Redis
export async function getCachedSorteoList(params) {
  const cacheKey = generateCacheKey(params);
  return await CacheService.get(cacheKey);
}

export async function setCachedSorteoList(params, data, meta) {
  const cacheKey = generateCacheKey(params);
  await CacheService.set(cacheKey, { data, meta }, 30); // 30 segundos TTL
}
```

**⭐ Prioridad:** CRÍTICO

---

### 4. CACHÉ EN MEMORIA: Map sin Límite en commissionCache

**🔴 Problema:**
Caché de políticas de comisión parseadas usa Map global sin límite de tamaño.

**📍 Ubicación:**
[src/utils/commissionCache.ts:15](src/utils/commissionCache.ts#L15)

**🧠 Por qué es peligroso:**

```typescript
// LÍNEA 15: Map global sin límite
const commissionPolicyCache = new Map<string, CachedPolicy>();

// LÍNEA 39-42: No hay cleanup automático
commissionPolicyCache.set(cacheKey, {
  policy,
  expiresAt: Date.now() + CACHE_TTL_MS,
});
```

**Riesgos:**

- Clave única por entidad: `${entityType}:${entityId}`
- Con 100 ventanas + 500 vendedores + 10 bancas = **610 entradas**
- Cada política parseada puede ser grande (JSON jerárquico de comisiones)
- TTL de 5 minutos pero **NO se limpian entradas expiradas automáticamente**
- El Map crece infinitamente con cada nuevo vendedor/ventana creado

**📈 Impacto esperado:**

- Tamaño promedio por política: 2-10KB
- Memoria estimada: **1.2-6MB** inicialmente
- Crecimiento: **+500KB por cada 50 nuevos vendedores**
- Entradas expiradas nunca se eliminan → memory leak progresivo

**✅ Recomendación:**

```typescript
// SOLUCIÓN 1: Limpieza periódica de entradas expiradas
let cleanupInterval: NodeJS.Timeout | null = null;

function startCleanupInterval() {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(() => {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, cached] of commissionPolicyCache.entries()) {
      if (cached.expiresAt <= now) {
        commissionPolicyCache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug({
        layer: 'cache',
        action: 'COMMISSION_CACHE_CLEANUP',
        payload: { cleaned, remaining: commissionPolicyCache.size }
      });
    }
  }, 60 * 1000); // Cleanup cada 1 minuto
}

// Llamar en inicialización
startCleanupInterval();

// SOLUCIÓN 2: Límite de tamaño con LRU
const MAX_CACHE_SIZE = 1000; // Máximo 1000 entradas

function getCachedCommissionPolicy(...) {
  // ... código existente ...

  // Evict LRU si excede límite
  if (commissionPolicyCache.size >= MAX_CACHE_SIZE) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, cached] of commissionPolicyCache.entries()) {
      if (cached.expiresAt < oldestTime) {
        oldestTime = cached.expiresAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      commissionPolicyCache.delete(oldestKey);
    }
  }

  commissionPolicyCache.set(cacheKey, { policy, expiresAt: Date.now() + CACHE_TTL_MS });
  return policy;
}

// SOLUCIÓN 3: Migrar a Redis (preferible)
// Usar CacheService ya existente
```

**⭐ Prioridad:** CRÍTICO

---

### 5. CACHÉ V2: setInterval Perpetuo en Warming Process

**🔴 Problema:**
El sistema de caché V2 (`restrictionCacheV2.ts`) crea un `setInterval` perpetuo en el constructor, ejecutándose cada 30 segundos **sin forma de detenerlo**.

**📍 Ubicación:**
[src/utils/restrictionCacheV2.ts:431-439](src/utils/restrictionCacheV2.ts#L431-L439)

**🧠 Por qué es peligroso:**

```typescript
// LÍNEA 68-84: Constructor inicia warming automáticamente
constructor(config: Partial<CacheConfig> = {}) {
  this.config = { ...DEFAULT_CONFIG, ...config };
  // ...

  // ⚠️ PROBLEMA: Inicia proceso en background SIN referencia para detener
  if (this.config.warmingEnabled) {
    this.startWarmingProcess(); // ← No se puede detener después
  }
}

// LÍNEA 431-439: setInterval SIN referencia guardada
private startWarmingProcess(): void {
  setInterval(async () => { // ❌ NO se guarda la referencia del interval
    if (this.warmingQueue.size > 0) {
      const keys = Array.from(this.warmingQueue);
      this.warmingQueue.clear();
      await this.warmCache(keys);
    }
  }, 30000); // ← Se ejecuta cada 30 segundos PERPETUAMENTE
}

// LÍNEA 582: Exporta instancia singleton
export const restrictionCacheV2 = new RestrictionCacheV2();
```

**Riesgos:**

- El interval se crea al importar el archivo (side effect en module load)
- **NO hay forma de detener el interval** (no se guarda la referencia)
- Si el archivo se importa en tests, el interval sigue ejecutándose incluso después de terminar los tests
- En desarrollo con hot-reload, cada reload crea un **nuevo interval acumulativo**
- Graceful shutdown del servidor NO detiene este interval

**📈 Impacto esperado:**

- Ejecuciones: 2880/día (cada 30 segundos)
- Con 5 hot-reloads en desarrollo: **14,400 ejecuciones/día**
- Cada ejecución hace queries a Redis para warm cache
- Alto overhead de CPU y red incluso cuando no hay tráfico

**✅ Recomendación:**

```typescript
class RestrictionCacheV2 {
  private config: CacheConfig;
  private metrics: CacheMetrics;
  private warmingQueue: Set<string> = new Set();
  private dependencyGraph: Map<string, Set<string>> = new Map();
  private memoryUsage: number = 0;
  private warmingInterval: NodeJS.Timeout | null = null; // ← AGREGAR

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // ... código existente ...

    // ✅ NO iniciar automáticamente en constructor
    // Dejar que el caller decida cuándo iniciar
  }

  /**
   * Inicia el proceso de warming (debe llamarse explícitamente)
   */
  public startWarmingProcess(): void {
    if (this.warmingInterval) {
      logger.warn({
        layer: 'cache',
        action: 'WARMING_ALREADY_STARTED',
        payload: { message: 'Cache warming already running' }
      });
      return;
    }

    if (!this.config.warmingEnabled) {
      return;
    }

    this.warmingInterval = setInterval(async () => {
      if (this.warmingQueue.size > 0) {
        const keys = Array.from(this.warmingQueue);
        this.warmingQueue.clear();
        await this.warmCache(keys);
      }
    }, 30000);

    logger.info({
      layer: 'cache',
      action: 'WARMING_STARTED',
      payload: { interval: '30s' }
    });
  }

  /**
   * Detiene el proceso de warming
   */
  public stopWarmingProcess(): void {
    if (this.warmingInterval) {
      clearInterval(this.warmingInterval);
      this.warmingInterval = null;

      logger.info({
        layer: 'cache',
        action: 'WARMING_STOPPED'
      });
    }
  }
}

// En server.ts, iniciar/detener explícitamente:
import { restrictionCacheV2 } from './utils/restrictionCacheV2';

server.listen(port, () => {
  restrictionCacheV2.startWarmingProcess(); // ← Iniciar explícitamente
});

const gracefulShutdown = async () => {
  restrictionCacheV2.stopWarmingProcess(); // ← Detener en shutdown
  // ... resto del shutdown
};
```

**⭐ Prioridad:** CRÍTICO

---

### 6. CACHÉ V2: Dependencias Cíclicas y Memory Leak en Dependency Graph

**🔴 Problema:**
El sistema de dependency tracking en CacheV2 puede crear ciclos y nunca liberar memoria.

**📍 Ubicación:**
[src/utils/restrictionCacheV2.ts:65](src/utils/restrictionCacheV2.ts#L65)
[src/utils/restrictionCacheV2.ts:211-217](src/utils/restrictionCacheV2.ts#L211-L217)
[src/utils/restrictionCacheV2.ts:323-357](src/utils/restrictionCacheV2.ts#L323-L357)

**🧠 Por qué es peligroso:**

```typescript
// LÍNEA 65: Map que crece infinitamente
private dependencyGraph: Map<string, Set<string>> = new Map();

// LÍNEA 211-217: Agregar dependencias sin límite
private trackDependency(parentKey: string, dependentKey: string): void {
  if (!this.dependencyGraph.has(parentKey)) {
    this.dependencyGraph.set(parentKey, new Set());
  }
  this.dependencyGraph.get(parentKey)!.add(dependentKey);
  // ❌ PROBLEMA: Nunca se eliminan claves del dependencyGraph
}

// LÍNEA 323-357: Invalidación recursiva sin protección contra ciclos
async delete(key: string): Promise<void> {
  // ... código ...

  const dependents = this.dependencyGraph.get(key);
  if (dependents) {
    for (const dependent of dependents) {
      await this.delete(dependent); // ⚠️ Recursión sin límite
      this.metrics.invalidations++;
    }
    this.dependencyGraph.delete(key); // ← Solo se borra DESPUÉS de procesar
  }
}
```

**Riesgos:**

- Si A depende de B y B depende de A → **stack overflow** en delete()
- El `dependencyGraph` nunca se limpia cuando expiran claves (solo cuando se llama `delete()` explícitamente)
- Claves que expiran por TTL quedan huérfanas en el graph
- Con 1000 claves cacheadas → dependencyGraph puede tener 5000+ entradas

**📈 Impacto esperado:**

- Memoria del graph: ~100 bytes por relación
- Con 5000 relaciones: **~500KB** solo para el graph
- Crecimiento: **+50KB por día** (entradas huérfanas nunca removidas)
- Crash por stack overflow si hay dependencias cíclicas

**✅ Recomendación:**

```typescript
class RestrictionCacheV2 {
  private dependencyGraph: Map<string, Set<string>> = new Map();
  private visitedKeys: Set<string> = new Set(); // ← Protección contra ciclos

  /**
   * Delete con protección contra ciclos
   */
  async delete(key: string, visited: Set<string> = new Set()): Promise<void> {
    // Protección contra ciclos
    if (visited.has(key)) {
      logger.warn({
        layer: 'cache',
        action: 'CIRCULAR_DEPENDENCY_DETECTED',
        payload: { key, visited: Array.from(visited) }
      });
      return;
    }

    visited.add(key);

    try {
      // Get entry to check dependencies
      const entry = await CacheService.get<CacheEntry<any>>(key);
      if (entry) {
        this.updateMemoryUsage(-entry.size);
      }

      await CacheService.del(key);
      this.metrics.deletes++;

      // Invalidate dependencies recursivamente con protección
      const dependents = this.dependencyGraph.get(key);
      if (dependents) {
        for (const dependent of dependents) {
          await this.delete(dependent, visited); // ← Pasar visited set
          this.metrics.invalidations++;
        }
        this.dependencyGraph.delete(key); // ✅ Limpiar del graph
      }
    } catch (error) {
      logger.warn({
        layer: 'cache',
        action: 'CACHE_DELETE_ERROR_V2',
        payload: { key, error: (error as Error).message },
      });
    }
  }

  /**
   * Cleanup periódico del dependency graph (eliminar claves expiradas)
   */
  private cleanupDependencyGraph(): void {
    const now = Date.now();
    const keysToRemove: string[] = [];

    for (const [key, _] of this.dependencyGraph.entries()) {
      // Verificar si la clave sigue existiendo en cache
      CacheService.exists(key).then(exists => {
        if (!exists) {
          keysToRemove.push(key);
        }
      });
    }

    // Eliminar claves huérfanas
    for (const key of keysToRemove) {
      this.dependencyGraph.delete(key);
    }

    if (keysToRemove.length > 0) {
      logger.info({
        layer: 'cache',
        action: 'DEPENDENCY_GRAPH_CLEANUP',
        payload: { removed: keysToRemove.length, remaining: this.dependencyGraph.size }
      });
    }
  }

  // Ejecutar cleanup cada 10 minutos
  private startDependencyCleanup(): void {
    setInterval(() => {
      this.cleanupDependencyGraph();
    }, 10 * 60 * 1000);
  }
}
```

**⭐ Prioridad:** CRÍTICO

---

### 7. REDIS CLIENT: Event Listeners Acumulándose sin Cleanup

**🔴 Problema:**
El cliente Redis estándar (ioredis) agrega event listeners que nunca se remueven.

**📍 Ubicación:**
[src/core/redisClient.ts:117-135](src/core/redisClient.ts#L117-L135)

**🧠 Por qué es peligroso:**

```typescript
// LÍNEA 117-135: Event handlers SIN removeListener
redisClient.on('error', (err: Error) => {
  logger.error({ layer: 'redis', action: 'ERROR', payload: { error: err.message } });
  redisAvailable = false;
});

redisClient.on('connect', () => {
  logger.info({ layer: 'redis', action: 'CONNECTED' });
  redisAvailable = true;
});

redisClient.on('ready', () => {
  logger.info({ layer: 'redis', action: 'READY' });
  redisAvailable = true;
});

redisClient.on('close', () => {
  logger.warn({ layer: 'redis', action: 'CLOSED' });
  redisAvailable = false;
});
```

**Riesgos:**

- Si `initRedisClient()` se llama múltiples veces (tests, reconexiones), se agregan **listeners duplicados**
- Node.js emite warning: `MaxListenersExceededWarning` después de 10 listeners
- Cada listener duplicado consume memoria (~100 bytes + closures)
- Logs duplicados en cada evento Redis

**📈 Impacto esperado:**

- Con 10 llamadas a `initRedisClient()`: **40 listeners** (4 eventos × 10)
- Memoria: ~4KB de overhead
- Performance: logs duplicados 10x
- Warning spam en consola

**✅ Recomendación:**

```typescript
export async function initRedisClient(): Promise<void> {
  // ... código existente ...

  // ✅ Remover listeners previos antes de agregar nuevos
  if (redisClient) {
    redisClient.removeAllListeners('error');
    redisClient.removeAllListeners('connect');
    redisClient.removeAllListeners('ready');
    redisClient.removeAllListeners('close');
  }

  // Event handlers
  redisClient.on('error', handleRedisError);
  redisClient.on('connect', handleRedisConnect);
  redisClient.on('ready', handleRedisReady);
  redisClient.on('close', handleRedisClose);
}

// Definir handlers como funciones nombradas para poder removerlos
function handleRedisError(err: Error) {
  logger.error({ layer: 'redis', action: 'ERROR', payload: { error: err.message } });
  redisAvailable = false;
}

function handleRedisConnect() {
  logger.info({ layer: 'redis', action: 'CONNECTED' });
  redisAvailable = true;
}

function handleRedisReady() {
  logger.info({ layer: 'redis', action: 'READY' });
  redisAvailable = true;
}

function handleRedisClose() {
  logger.warn({ layer: 'redis', action: 'CLOSED' });
  redisAvailable = false;
}

// En closeRedisClient, limpiar listeners
export async function closeRedisClient(): Promise<void> {
  if (redisClient) {
    try {
      // ✅ Remover listeners antes de cerrar
      redisClient.removeAllListeners();

      await redisClient.quit();
      logger.info({ layer: 'redis', action: 'DISCONNECTED' });
    } catch (error) {
      logger.error({
        layer: 'redis',
        action: 'DISCONNECT_ERROR',
        payload: { error: (error as Error).message }
      });
    } finally {
      redisClient = null;
      redisAvailable = false;
    }
  }
}
```

**⭐ Prioridad:** CRÍTICO

---

## 🟠 PROBLEMAS ALTOS

### 8. QUERIES: findMany sin LIMIT en Account Statement Settlement

**🔴 Problema:**
El job de asentamiento de estados de cuenta busca todos los statements antiguos sin límite real.

**📍 Ubicación:**
[src/jobs/accountStatementSettlement.job.ts:148-166](src/jobs/accountStatementSettlement.job.ts#L148-L166)

**🧠 Por qué es peligroso:**

```typescript
// LÍNEA 148-166: Query con batchSize pero sin validación
const statementsToSettle = await prisma.accountStatement.findMany({
  where: {
    isSettled: false,
    date: {
      lt: cutoffDateCR
    }
  },
  include: {
    payments: {
      where: {
        isReversed: false
      }
    }
  },
  orderBy: {
    date: 'asc'
  },
  take: config.batchSize // ← Por defecto 1000, pero podría ser mayor
});
```

**Riesgos:**

- `config.batchSize` por defecto es 1000 (línea 73), pero no hay validación de límite superior
- Si un admin configura `batchSize: 999999` → query retorna TODOS los statements
- Cada statement incluye array de `payments` (relación 1:N)
- Con 1000 statements × 10 payments promedio = **10,000 registros en memoria**

**📈 Impacto esperado:**

- Con 1000 statements pendientes: ~5-10MB en memoria
- Con 10,000 statements (mal configurado): **50-100MB** en una sola query
- Bloqueo de event loop por 500-1000ms procesando el resultado

**✅ Recomendación:**

```typescript
// LÍNEA 64-76: Agregar validación de batchSize
let config = await prisma.accountStatementSettlementConfig.findFirst();

if (!config) {
  config = await prisma.accountStatementSettlementConfig.create({
    data: {
      enabled: false,
      settlementAgeDays: 7,
      batchSize: 1000, // Default
    },
  });
}

// ✅ AGREGAR: Validar límite superior de batchSize
const MAX_BATCH_SIZE = 2000;
const safeBatchSize = Math.min(config.batchSize, MAX_BATCH_SIZE);

if (config.batchSize > MAX_BATCH_SIZE) {
  logger.warn({
    layer: 'job',
    action: 'SETTLEMENT_BATCH_SIZE_CAPPED',
    payload: {
      configuredSize: config.batchSize,
      cappedSize: safeBatchSize,
      message: `Batch size capped to ${MAX_BATCH_SIZE} to prevent memory issues`
    }
  });
}

// Usar safeBatchSize en lugar de config.batchSize
const statementsToSettle = await prisma.accountStatement.findMany({
  // ... where ...
  take: safeBatchSize, // ← Usar límite validado
});

// ✅ AGREGAR: Paginación si hay más registros
if (statementsToSettle.length === safeBatchSize) {
  logger.info({
    layer: 'job',
    action: 'SETTLEMENT_MORE_RECORDS_AVAILABLE',
    payload: {
      processed: safeBatchSize,
      message: 'More records available, will process in next run'
    }
  });
}
```

**⭐ Prioridad:** ALTO

---

### 9. QUERIES: Monthly Closing sin Paginación para Ventanas/Bancas

**🔴 Problema:**
El job de cierre mensual carga TODAS las ventanas y bancas activas sin paginación.

**📍 Ubicación:**
[src/jobs/monthlyClosing.job.ts:124-132](src/jobs/monthlyClosing.job.ts#L124-L132)
[src/jobs/monthlyClosing.job.ts:203-210](src/jobs/monthlyClosing.job.ts#L203-L210)

**🧠 Por qué es peligroso:**

```typescript
// LÍNEA 124-132: Query sin LIMIT para ventanas
const ventanas = await prisma.ventana.findMany({
  where: {
    isActive: true,
  },
  select: {
    id: true,
    bancaId: true,
  },
});

// LÍNEA 203-210: Query sin LIMIT para bancas
const bancas = await prisma.banca.findMany({
  where: {
    isActive: true,
  },
  select: {
    id: true,
  },
});
```

**Riesgos:**

- Asume que el número de ventanas/bancas es pequeño
- En un sistema en crecimiento, podría haber **100+ ventanas y 20+ bancas**
- Procesar todas en un solo batch puede tomar minutos
- Si una falla, todo el batch se detiene (no hay checkpoint)

**📈 Impacto esperado:**

- Con 100 ventanas: ~15-30 segundos de procesamiento
- Con 500 ventanas: **2-5 minutos** (timeout posible)
- Uso de CPU al 100% durante el procesamiento
- Posible timeout en infraestructura Render (30s request timeout)

**✅ Recomendación:**

```typescript
// Procesar en batches con paginación
async function processVentanasInBatches(closingMonth: string) {
  const BATCH_SIZE = 50; // Procesar 50 ventanas a la vez
  let skip = 0;
  let totalSuccess = 0;
  let totalErrors = 0;

  while (true) {
    const ventanas = await prisma.ventana.findMany({
      where: { isActive: true },
      select: { id: true, bancaId: true },
      take: BATCH_SIZE,
      skip: skip,
      orderBy: { id: 'asc' } // ← Importante para paginación consistente
    });

    if (ventanas.length === 0) break;

    logger.info({
      layer: 'job',
      action: 'MONTHLY_CLOSING_BATCH_START',
      payload: {
        entity: 'ventana',
        batchStart: skip,
        batchSize: ventanas.length
      }
    });

    for (const ventana of ventanas) {
      try {
        const balance = await calculateRealMonthBalance(
          closingMonth,
          'ventana',
          ventana.id,
          undefined,
          ventana.bancaId || undefined
        );

        await saveMonthlyClosingBalance(
          closingMonth,
          'ventana',
          balance,
          ventana.id,
          undefined,
          ventana.bancaId || undefined
        );

        totalSuccess++;
      } catch (error: any) {
        totalErrors++;
        logger.error({
          layer: 'job',
          action: 'MONTHLY_CLOSING_VENTANA_ERROR',
          payload: {
            closingMonth,
            ventanaId: ventana.id,
            error: error.message,
          },
        });
      }
    }

    skip += BATCH_SIZE;

    // Pausa entre batches para no saturar DB
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return { success: totalSuccess, errors: totalErrors };
}
```

**⭐ Prioridad:** ALTO

---

### 10. CACHÉ: accountStatementCache con Múltiples Patrones de Invalidación Costosos

**🔴 Problema:**
La invalidación de caché de account statements usa `delPattern()` con patrones complejos que ejecutan `keys()` en Redis.

**📍 Ubicación:**
[src/utils/accountStatementCache.ts:217-283](src/utils/accountStatementCache.ts#L217-L283)

**🧠 Por qué es peligroso:**

```typescript
// LÍNEA 225-258: Múltiples patrones de invalidación
export async function invalidateAccountStatementCache(params: {
  date: string;
  ventanaId?: string | null;
  vendedorId?: string | null;
}): Promise<void> {
  try {
    const month = params.date.substring(0, 7);
    const patterns: string[] = [];
    let totalKeysDeleted = 0;

    // 1. Invalidar día específico
    const dayPattern = `account:day:${params.date}:*`;
    const dayKeys = await CacheService.delPattern(dayPattern); // ← KEYS() en Redis

    // 2. Invalidar mes
    const monthPattern = `account:statement:${month}:*`;
    const monthKeys = await CacheService.delPattern(monthPattern); // ← KEYS() en Redis

    // 3. Invalidar períodos
    patterns.push(`account:statement:*:null:${params.date}:*`); // ← Wildcards múltiples
    patterns.push(`account:statement:*:null:*:${params.date}:*`);

    // 4. Si hay ventanaId o vendedorId
    if (params.ventanaId) {
      patterns.push(`account:statement:*:*:*:*:*:${params.ventanaId}:*`); // ← 8 wildcards!
    }

    // Invalidar todos los patrones
    for (const pattern of patterns) {
      const deleted = await CacheService.delPattern(pattern); // ← KEYS() en Redis × N
      totalKeysDeleted += deleted?.length || 0;
    }
  }
}
```

**Riesgos:**

- `CacheService.delPattern()` usa `redis.keys(pattern)` que es **O(N)** donde N = total de claves en Redis
- Con 10,000 claves en Redis, cada `keys()` escanea las 10,000 claves
- Se ejecutan **4-6 patrones por invalidación** → 40,000-60,000 operaciones
- `keys()` bloquea Redis (single-threaded) por 10-100ms
- Se ejecuta en CADA ticket/payment creado/modificado

**📈 Impacto esperado:**

- Con 100 tickets/día: **400-600 operaciones `keys()`** al día
- Cada `keys()` bloquea Redis por 10-50ms
- Total de bloqueo: **4-30 segundos/día** de Redis bloqueado
- En tráfico alto (1000 tickets/día): **40-300 segundos/día** bloqueado

**✅ Recomendación:**

```typescript
// OPCIÓN 1: Usar SCAN en lugar de KEYS (no bloquea Redis)
export async function invalidateAccountStatementCacheV2(params: {
  date: string;
  ventanaId?: string | null;
  vendedorId?: string | null;
}): Promise<void> {
  try {
    const month = params.date.substring(0, 7);
    const patterns = [
      `account:day:${params.date}:*`,
      `account:statement:${month}:*`,
      // ... otros patrones
    ];

    // Usar SCAN en lugar de KEYS (no bloquea)
    for (const pattern of patterns) {
      await invalidatePatternWithScan(pattern);
    }
  } catch (error) {
    logger.warn({
      layer: 'cache',
      action: 'INVALIDATE_ERROR',
      payload: { error: (error as Error).message, date: params.date }
    });
  }
}

async function invalidatePatternWithScan(pattern: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  let cursor = '0';
  let totalDeleted = 0;

  do {
    // SCAN no bloquea Redis (procesa en chunks)
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH', pattern,
      'COUNT', 100 // Procesar 100 claves a la vez
    );

    cursor = nextCursor;

    if (keys.length > 0) {
      await redis.del(...keys);
      totalDeleted += keys.length;
    }
  } while (cursor !== '0');

  logger.debug({
    layer: 'cache',
    action: 'PATTERN_INVALIDATED',
    payload: { pattern, deleted: totalDeleted }
  });
}

// OPCIÓN 2: Usar conjuntos de claves para invalidación O(1)
// Al crear caché, agregar la clave a un set:
await redis.sadd(`cache:index:${month}`, cacheKey);

// Al invalidar, recuperar claves del set:
const keysToDelete = await redis.smembers(`cache:index:${month}`);
if (keysToDelete.length > 0) {
  await redis.del(...keysToDelete);
  await redis.del(`cache:index:${month}`);
}
```

**⭐ Prioridad:** ALTO

---

### 11. PRISMA: Conexiones sin Desconexión en Shutdown Incompleto

**🔴 Problema:**
El graceful shutdown no garantiza que todas las operaciones Prisma terminen antes de cerrar.

**📍 Ubicación:**
[src/server/server.ts:139-161](src/server/server.ts#L139-L161)

**🧠 Por qué es peligroso:**

```typescript
// LÍNEA 139-161: Shutdown sin esperar operaciones pendientes
server.close(async (err) => {
  if (err) {
    logger.error({
      layer: 'server',
      action: 'SERVER_CLOSE_ERROR',
      meta: { error: (err as Error).message },
    })
    process.exit(1)
  }

  try {
    await prisma.$disconnect() // ← Puede desconectar con queries en curso
    logger.info({ layer: 'server', action: 'PRISMA_DISCONNECTED' })
    process.exit(0)
  } catch (e) {
    logger.error({
      layer: 'server',
      action: 'PRISMA_DISCONNECT_ERROR',
      meta: { error: (e as Error).message },
    })
    process.exit(1)
  }
})
```

**Riesgos:**

- Si hay jobs de larga duración (monthly closing, settlement) ejecutándose, se cortan abruptamente
- Transacciones activas pueden quedar en estado inconsistente
- Connection pool se cierra sin esperar queries pendientes
- En Render, el shutdown timeout es 30s → si la desconexión tarda más, se mata el proceso

**📈 Impacto esperado:**

- 1-5% de shutdowns pueden interrumpir jobs activos
- Datos parcialmente procesados (ej: 50/100 ventanas procesadas)
- Conexiones huérfanas en PostgreSQL (se limpian después de timeout)

**✅ Recomendación:**

```typescript
// Agregar flag de shutdown
let isShuttingDown = false;
const activeOperations = new Set<string>();

// Wrapper para operaciones críticas
async function withShutdownProtection<T>(
  operationId: string,
  fn: () => Promise<T>
): Promise<T> {
  if (isShuttingDown) {
    throw new Error('Server is shutting down, operation rejected');
  }

  activeOperations.add(operationId);

  try {
    return await fn();
  } finally {
    activeOperations.delete(operationId);
  }
}

// En jobs críticos, usar el wrapper
export async function executeMonthlyClosing(...) {
  return withShutdownProtection('monthly-closing', async () => {
    // ... lógica del job
  });
}

// Graceful shutdown mejorado
const gracefulShutdown = async (signal: string) => {
  logger.info({ layer: 'server', action: 'SHUTDOWN_INITIATED', payload: { signal } });

  // Marcar que estamos en shutdown (rechazar nuevas operaciones)
  isShuttingDown = true;

  // Detener jobs
  stopSorteosAutoJobs();
  stopAccountStatementSettlementJob();
  stopMonthlyClosingJob();

  // Esperar operaciones activas (máximo 25 segundos)
  const MAX_WAIT = 25000;
  const startWait = Date.now();

  while (activeOperations.size > 0 && Date.now() - startWait < MAX_WAIT) {
    logger.info({
      layer: 'server',
      action: 'WAITING_FOR_OPERATIONS',
      payload: {
        pending: activeOperations.size,
        operations: Array.from(activeOperations)
      }
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  if (activeOperations.size > 0) {
    logger.warn({
      layer: 'server',
      action: 'SHUTDOWN_FORCE',
      payload: {
        pending: activeOperations.size,
        operations: Array.from(activeOperations)
      }
    });
  }

  // Cerrar servidor HTTP
  server.close(async (err) => {
    if (err) {
      logger.error({
        layer: 'server',
        action: 'SERVER_CLOSE_ERROR',
        meta: { error: (err as Error).message },
      });
      process.exit(1);
    }

    // Cerrar Redis
    try {
      await closeRedisClient();
    } catch (error: any) {
      logger.warn({
        layer: 'server',
        action: 'REDIS_CLOSE_ERROR',
        meta: { error: error.message },
      });
    }

    // Desconectar Prisma
    try {
      await prisma.$disconnect();
      logger.info({ layer: 'server', action: 'PRISMA_DISCONNECTED' });
      process.exit(0);
    } catch (e) {
      logger.error({
        layer: 'server',
        action: 'PRISMA_DISCONNECT_ERROR',
        meta: { error: (e as Error).message },
      });
      process.exit(1);
    }
  });
};
```

**⭐ Prioridad:** ALTO

---

### 12. MIDDLEWARE: Express Middlewares sin Cleanup de Listeners

**🔴 Problema:**
Los middlewares globales se registran con `app.use()` pero no hay verificación de duplicados.

**📍 Ubicación:**
[src/server/app.ts:28-44](src/server/app.ts#L28-L44)

**🧠 Por qué es peligroso:**

```typescript
// LÍNEA 28-44: Middlewares globales sin protección contra duplicados
app.use(requestIdMiddleware)
app.use(attachRequestLogger)
app.use(helmet())
app.use(corsMiddleware)
app.use('/public', express.static(path.join(process.cwd(), 'public')));
app.use(express.json({ limit: '200kb' }))
app.use(requireJson)
app.use(express.urlencoded({ extended: true }))
app.use(rateLimitMiddleware)

if (config.nodeEnv !== 'production') {
  app.use(morgan('dev'))
}

app.use('/api/v1', apiV1Router)
app.use(errorHandler)
```

**Riesgos:**

- Si `app.ts` se reimporta (tests, hot-reload), los middlewares se **agregan de nuevo**
- Cada request pasa por middlewares duplicados → overhead de 2x, 3x, etc.
- `requestIdMiddleware` genera múltiples IDs por request
- `rateLimitMiddleware` cuenta requests múltiples veces

**📈 Impacto esperado:**

- Con 3 reloads: cada request pasa por **3x middlewares**
- Latencia: +10-30ms por request (overhead de procesamiento duplicado)
- Rate limiting incorrecto (bloquea requests legítimos)

**✅ Recomendación:**

```typescript
// OPCIÓN 1: Crear app en función y no reimportar
export function createApp() {
  const app = express();

  // ... configurar middlewares

  return app;
}

// En server.ts, llamar una sola vez
const app = createApp();

// OPCIÓN 2: Protección contra múltiples inicializaciones
let appInitialized = false;

if (!appInitialized) {
  app.use(requestIdMiddleware);
  app.use(attachRequestLogger);
  // ... resto de middlewares

  appInitialized = true;
}

// OPCIÓN 3 (mejor): No reimportar app.ts en tests
// Usar factory pattern en tests
```

**⭐ Prioridad:** ALTO

---

## 🟡 PROBLEMAS MEDIOS

### 13. MEMORY: sorteoCache Cleanup Interval Ejecuta Globalmente

**🔴 Problema:**
El cleanup de sorteo cache se ejecuta automáticamente al importar el archivo.

**📍 Ubicación:**
[src/utils/sorteoCache.ts:186-188](src/utils/sorteoCache.ts#L186-L188)

**🧠 Por qué es peligroso:**

```typescript
// LÍNEA 186-188: setInterval ejecuta al importar (side effect)
if (typeof setInterval !== 'undefined') {
  setInterval(cleanupExpiredSorteoCache, 5 * 60 * 1000);
}
```

**Riesgos:**

- Side effect en module load (anti-pattern)
- Se ejecuta en tests, workers, y procesos que no necesitan el cleanup
- No se puede detener (no se guarda la referencia del interval)

**📈 Impacto esperado:**

- Overhead mínimo: 288 ejecuciones/día
- En tests: intervals huérfanos que siguen ejecutándose
- Pequeño leak de memoria por closures

**✅ Recomendación:**

```typescript
let cleanupInterval: NodeJS.Timeout | null = null;

export function startSorteoCacheCleanup(): void {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(cleanupExpiredSorteoCache, 5 * 60 * 1000);
}

export function stopSorteoCacheCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// Llamar explícitamente en server.ts
import { startSorteoCacheCleanup, stopSorteoCacheCleanup } from './utils/sorteoCache';

server.listen(port, () => {
  startSorteoCacheCleanup();
});

const gracefulShutdown = async () => {
  stopSorteoCacheCleanup();
  // ...
};
```

**⭐ Prioridad:** MEDIO

---

### 14. PERFORMANCE: CacheService.delPattern usa redis.keys() sin SCAN

**🔴 Problema:**
`CacheService.delPattern()` usa `redis.keys()` que bloquea Redis.

**📍 Ubicación:**
[src/core/cache.service.ts:99-124](src/core/cache.service.ts#L99-L124)

**🧠 Por qué es peligroso:**

```typescript
// LÍNEA 109-123
static async delPattern(pattern: string): Promise<string[] | null> {
  // ...
  try {
    const keys = await redis.keys(pattern); // ❌ Bloquea Redis O(N)
    if (keys.length > 0) {
      await redis.del(...keys);
      return keys;
    }
    return [];
  } catch (error) {
    // ...
  }
}
```

**Riesgos:**

- `keys()` es O(N) y bloquea Redis (single-threaded)
- Se usa en invalidaciones frecuentes (account statements, restrictions)

**📈 Impacto esperado:**

- Con 10,000 claves: 10-50ms de bloqueo por llamada
- Con 100 invalidaciones/día: **1-5 segundos** de Redis bloqueado

**✅ Recomendación:**

```typescript
static async delPattern(pattern: string): Promise<string[] | null> {
  if (!isRedisAvailable()) {
    return null;
  }

  const redis = getRedisClient();
  if (!redis) {
    return null;
  }

  try {
    const deletedKeys: string[] = [];
    let cursor = '0';

    // Usar SCAN en lugar de KEYS
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        'MATCH', pattern,
        'COUNT', 100
      );

      cursor = nextCursor;

      if (keys.length > 0) {
        await redis.del(...keys);
        deletedKeys.push(...keys);
      }
    } while (cursor !== '0');

    return deletedKeys;
  } catch (error) {
    logger.warn({
      layer: 'cache',
      action: 'DEL_PATTERN_ERROR',
      payload: { pattern, error: (error as Error).message }
    });
    return null;
  }
}
```

**⭐ Prioridad:** MEDIO

---

### 15. QUERIES: Dashboard Service con Múltiples findMany sin LIMIT

**🔴 Problema:**
El servicio de dashboard ejecuta múltiples queries sin paginación para estadísticas.

**📍 Ubicación:**
[src/api/v1/services/dashboard.service.ts](src/api/v1/services/dashboard.service.ts) (archivo de 4174 líneas)

**🧠 Por qué es peligroso:**

- El archivo tiene **23 ocurrencias de findMany/count**
- Queries para estadísticas globales pueden retornar miles de registros
- Ejemplo: top vendedores, top ventanas, tickets recientes sin LIMIT

**📈 Impacto esperado:**

- Queries de dashboard pueden tardar 500-2000ms
- Con tráfico concurrente: saturación de DB connection pool
- Alto uso de memoria al procesar resultados grandes

**✅ Recomendación:**

```typescript
// Revisar todas las queries en dashboard.service.ts y agregar:
// 1. LIMIT/take explícito
// 2. Paginación cursor-based para datasets grandes
// 3. Agregaciones en DB en lugar de traer todo a memoria

// Ejemplo:
// ANTES:
const topVendedores = await prisma.ticket.groupBy({
  by: ['vendedorId'],
  _sum: { amount: true },
  orderBy: { _sum: { amount: 'desc' } }
  // ❌ Sin LIMIT → retorna TODOS los vendedores
});

// DESPUÉS:
const topVendedores = await prisma.ticket.groupBy({
  by: ['vendedorId'],
  _sum: { amount: true },
  orderBy: { _sum: { amount: 'desc' } },
  take: 10 // ✅ Solo top 10
});
```

**⭐ Prioridad:** MEDIO

---

## 🟢 PROBLEMAS BAJOS (Mejoras Preventivas)

### 16. OPTIMIZATION: Prisma Client Log Level en Producción

**🔴 Problema:**
Prisma está configurado para loggear `warn` y `error` en producción.

**📍 Ubicación:**
[src/core/prismaClient.ts:10-12](src/core/prismaClient.ts#L10-L12)

**✅ Recomendación:**

```typescript
const prisma = global.__prisma ?? new PrismaClient({
  log: config.nodeEnv === 'production'
    ? ['error'] // Solo errores en producción
    : ['warn', 'error'],
});
```

**⭐ Prioridad:** BAJO

---

### 17. CLEANUP: Activity Log Job usa console.log en lugar de logger

**🔴 Problema:**
El job de limpieza de activity logs usa `console.log` en lugar del logger estructurado.

**📍 Ubicación:**
[src/jobs/activityLogCleanup.job.ts:48-74](src/jobs/activityLogCleanup.job.ts#L48-L74)

**✅ Recomendación:**
Reemplazar todos los `console.log` y `console.error` con `logger.info` y `logger.error`.

**⭐ Prioridad:** BAJO

---

### 18. TYPE SAFETY: withTransactionRetry no limita recursión

**🔴 Problema:**
Las transacciones con retry no tienen protección contra stack overflow.

**📍 Ubicación:**
[src/core/withTransactionRetry.ts:40-97](src/core/withTransactionRetry.ts#L40-L97)

**✅ Recomendación:**
Agregar validación de que `maxRetries` no exceda 10.

**⭐ Prioridad:** BAJO

---

## 📊 RESUMEN DE PRIORIDADES

| Prioridad | Cantidad | Problemas |
|-----------|----------|-----------|
| 🔴 CRÍTICO | 7 | #1, #2, #3, #4, #5, #6, #7 |
| 🟠 ALTO | 5 | #8, #9, #10, #11, #12 |
| 🟡 MEDIO | 3 | #13, #14, #15 |
| 🟢 BAJO | 3 | #16, #17, #18 |

---

## 🎯 PLAN DE ACCIÓN RECOMENDADO

### Fase 1: Críticos (Semana 1)

1. **Día 1-2:** Arreglar duplicación de cron jobs (#1, #2)
2. **Día 3-4:** Implementar límites en cachés en memoria (#3, #4)
3. **Día 5:** Arreglar setInterval perpetuo en CacheV2 (#5)

### Fase 2: Memory Leaks (Semana 2)

1. **Día 1-2:** Protección contra ciclos en dependency graph (#6)
2. **Día 3:** Limpiar event listeners de Redis (#7)
3. **Día 4-5:** Agregar paginación en jobs críticos (#8, #9)

### Fase 3: Optimizaciones (Semana 3)

1. **Día 1-2:** Cambiar KEYS a SCAN en invalidaciones (#10, #14)
2. **Día 3-4:** Mejorar graceful shutdown (#11)
3. **Día 5:** Revisar middlewares (#12)

### Fase 4: Refinamiento (Semana 4)

1. Revisar dashboard queries (#15)
2. Limpiezas preventivas (#13, #16, #17, #18)
3. Testing completo y monitoreo

---

## 🔍 MÉTRICAS RECOMENDADAS PARA MONITOREO

### 1. Instrumentación de Memoria

```typescript
// Agregar en server.ts
setInterval(() => {
  const usage = process.memoryUsage();
  logger.info({
    layer: 'monitoring',
    action: 'MEMORY_USAGE',
    payload: {
      rss: Math.round(usage.rss / 1024 / 1024) + ' MB',
      heapUsed: Math.round(usage.heapUsed / 1024 / 1024) + ' MB',
      heapTotal: Math.round(usage.heapTotal / 1024 / 1024) + ' MB',
      external: Math.round(usage.external / 1024 / 1024) + ' MB'
    }
  });
}, 60 * 1000); // Cada minuto
```

### 2. Cache Statistics

```typescript
// En endpoints de health check
app.get('/api/v1/healthz', (_req, res) => {
  const cacheStats = {
    sorteoCache: getSorteoCacheStats(),
    commissionCache: getCommissionCacheStats(),
    restrictionCacheV2: restrictionCacheV2.getMetrics(),
  };

  res.status(200).json({
    status: 'ok',
    memory: process.memoryUsage(),
    cache: cacheStats
  });
});
```

### 3. Job Execution Tracking

```typescript
// Agregar métricas de jobs
const jobMetrics = {
  lastExecution: new Date(),
  executionCount: 0,
  errorCount: 0,
  avgDuration: 0
};
```

---

## 🧪 CÓMO VERIFICAR LAS SOLUCIONES EN PRODUCCIÓN

### Test 1: Memory Growth

```bash
# Antes de arreglos
watch -n 60 'curl https://your-api.com/api/v1/healthz | jq .memory.heapUsed'

# Debe estabilizarse después de arreglos (no crecer linealmente)
```

### Test 2: Cache Hit Rate

```bash
# Verificar métricas de caché
curl https://your-api.com/api/v1/healthz | jq .cache

# Hit rate debe ser >80% después de optimizaciones
```

### Test 3: Job Duplication

```bash
# Revisar logs para detectar duplicados
grep "SORTEOS_AUTO_OPEN_START" logs.txt | wc -l
# Debe ser ~1 por día, no múltiples
```

---

## 📚 RECURSOS Y REFERENCIAS

- **LRU Cache:** <https://www.npmjs.com/package/lru-cache>
- **Redis SCAN:** <https://redis.io/commands/scan/>
- **Node.js Memory Best Practices:** <https://nodejs.org/en/docs/guides/simple-profiling/>
- **Prisma Performance:** <https://www.prisma.io/docs/guides/performance-and-optimization>

---

**Fin del informe.**
