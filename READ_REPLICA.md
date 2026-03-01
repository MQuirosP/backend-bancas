# Read Replica — Documentación de implementación

Implementación completa de read replica para separar queries analíticos del primary.
Desarrollada en sesión 2026-02-28 / 2026-03-01. Revertida por inestabilidad en producción.

---

## Arquitectura

```
Cliente HTTP
     │
     ▼
Express (Render)
     │
     ├── Writes / reads críticas ──► PRIMARY (pgbouncer :6543)
     │                               DATABASE_URL
     │
     └── Reads analíticos ─────────► RÉPLICA (session pooler :5432)
                                      DATABASE_URL_REPLICA
```

### Por qué session pooler (5432) y no transaction pooler (6543)

`cierre.service.ts` usa `SET LOCAL statement_timeout` dentro de `$transaction`.
Esto requiere que la conexión sea persistente durante la transacción completa.
El transaction pooler (pgbouncer) reasigna conexiones entre queries, haciendo que
`SET LOCAL` no tenga efecto. El session pooler mantiene la sesión intacta.

---

## Variable de entorno

```env
# En Render (producción):
DATABASE_URL_REPLICA=postgresql://postgres.xhwxiofujvoaszojcoml-rr-us-east-2-agaan:EAnS8hLM4rXZjayd@aws-1-us-east-2.pooler.supabase.com:5432/postgres?connection_limit=5&pool_timeout=30&connect_timeout=15

# CRÍTICO: el username es postgres.{project-ref}, NO solo "postgres"
# Supabase session pooler usa el project-ref para enrutar al tenant correcto
# Error si username es incorrecto: FATAL: Tenant or user not found
```

Añadir en `src/config/env.schema.ts`:
```typescript
DATABASE_URL_REPLICA: z.string().optional(), // Read replica de Supabase. Si no se configura, el sistema usa el primary como fallback silencioso.
```

---

## Archivo nuevo: src/core/prismaReplica.ts

```typescript
/**
 * src/core/prismaReplica.ts
 *
 * Cliente Prisma para la réplica de solo lectura (read replica de Supabase).
 *
 * Uso:
 *   import { readDb } from "../../../core/prismaReplica";
 *   const rows = await readDb.$queryRaw`SELECT ...`;
 *
 * Reglas:
 *   - NUNCA usar readDb para operaciones de escritura (create, update, delete, upsert).
 *   - NUNCA pasar readDb a withTransactionRetry() ni a funciones que mezclen reads + writes.
 *   - Si DATABASE_URL_REPLICA no está configurado, el sistema usa el primary como fallback
 *     silencioso (útil en desarrollo sin réplica configurada).
 *   - Si la réplica está configurada pero temporalmente caída, el sistema hace fallback
 *     automático al primary para cada query fallida (circuit breaker por operación).
 *
 * Endpoint candidatos a readDb:
 *   GET /dashboard/*
 *   GET /reports/*
 *   GET /accounts/statement (solo lectura)
 *   GET /sorteos/evaluated-summary (date=month|week|year)
 *   GET /cierre/*
 *   GET /commissions/*
 */

import { PrismaClient } from "@prisma/client";
import prisma from "./prismaClient"; // fallback al primary
import logger from "./logger";

declare global {
    var __prismaReplica: PrismaClient | undefined;
}

/**
 * Operaciones de escritura prohibidas en la réplica.
 * En desarrollo lanza un error inmediato para detectar usos incorrectos.
 * En producción, la réplica rechazará la operación igualmente (es read-only).
 */
const WRITE_OPERATIONS = new Set([
    "create",
    "createMany",
    "createManyAndReturn",
    "update",
    "updateMany",
    "delete",
    "deleteMany",
    "upsert",
    "executeRaw",
    "runCommandRaw",
]);

/** Códigos Prisma que indican que la réplica es inalcanzable. */
const CONNECTION_ERROR_CODES = new Set(["P1001", "P1002", "P1003"]);

function isConnectionError(error: any): boolean {
    return (
        CONNECTION_ERROR_CODES.has(error?.code) ||
        Boolean(error?.message?.includes("Can't reach database")) ||
        Boolean(error?.message?.includes("connection pool")) ||
        Boolean(error?.message?.includes("connect ECONNREFUSED")) ||
        Boolean(error?.message?.includes("ETIMEDOUT"))
    );
}

/**
 * Envuelve el cliente de réplica con un proxy que, ante errores de conexión,
 * reintenta la operación en el primary automáticamente.
 */
function wrapWithFallback(replica: PrismaClient, primary: PrismaClient): PrismaClient {
    function withFallback(
        replicaFn: (...args: any[]) => any,
        primaryFn: (...args: any[]) => any,
        context: string
    ) {
        return (...args: any[]) => {
            const result = replicaFn(...args);
            if (result && typeof (result as any).catch === "function") {
                return (result as Promise<any>).catch((error: any) => {
                    if (isConnectionError(error)) {
                        logger.warn({
                            layer: "replica",
                            action: "REPLICA_FALLBACK_TO_PRIMARY",
                            meta: {
                                context,
                                errorCode: error?.code,
                                errorMessage: error?.message?.slice(0, 120),
                            },
                        });
                        return primaryFn(...args);
                    }
                    throw error;
                });
            }
            return result;
        };
    }

    return new Proxy(replica, {
        get(target, prop: string) {
            const replicaVal = (target as any)[prop];
            const primaryVal = (primary as any)[prop];

            if (typeof prop === "string" && prop.startsWith("$")) {
                if (typeof replicaVal === "function") {
                    return withFallback(
                        (...args: any[]) => replicaVal.apply(target, args),
                        (...args: any[]) => primaryVal.apply(primary, args),
                        prop
                    );
                }
                return replicaVal;
            }

            if (
                typeof replicaVal === "object" &&
                replicaVal !== null &&
                typeof primaryVal === "object" &&
                primaryVal !== null
            ) {
                return new Proxy(replicaVal, {
                    get(modelTarget, operation: string) {
                        const replicaOp = (modelTarget as any)[operation];
                        const primaryOp = (primaryVal as any)?.[operation];

                        if (typeof replicaOp === "function" && typeof primaryOp === "function") {
                            return withFallback(
                                (...args: any[]) => replicaOp.apply(modelTarget, args),
                                (...args: any[]) => primaryOp.apply(primaryVal, args),
                                `${prop}.${operation}`
                            );
                        }
                        return replicaOp;
                    },
                });
            }

            return replicaVal;
        },
    });
}

function wrapWithGuard(client: PrismaClient): PrismaClient {
    if (process.env.NODE_ENV === "production") return client;

    return new Proxy(client, {
        get(target, prop: string) {
            const value = (target as any)[prop];
            if (typeof value !== "object" || value === null) return value;

            return new Proxy(value, {
                get(modelTarget, operation: string) {
                    if (WRITE_OPERATIONS.has(operation)) {
                        throw new Error(
                            `[readDb] Operación de escritura '${operation}' no permitida en la réplica de lectura. ` +
                            `Usa 'prisma' (primary) para escrituras.`
                        );
                    }
                    return (modelTarget as any)[operation];
                },
            });
        },
    });
}

function createReplicaClient(): PrismaClient {
    const replicaUrl = process.env.DATABASE_URL_REPLICA;

    if (!replicaUrl) {
        return prisma; // fallback silencioso al primary
    }

    const client = new PrismaClient({
        log: ["warn", "error"],
        datasources: {
            db: { url: replicaUrl },
        },
    });

    const resilient = wrapWithFallback(client, prisma);
    return wrapWithGuard(resilient);
}

export function getPrismaReplica(): PrismaClient {
    if (!global.__prismaReplica) {
        global.__prismaReplica = createReplicaClient();
    }
    return global.__prismaReplica;
}

export const readDb: PrismaClient = getPrismaReplica();
```

---

## Servicios migrados a readDb

### Patrón de migración completa (import alias)

Para servicios que son 100% lectura, basta cambiar la línea de import:

```typescript
// ANTES:
import prisma from "../../../core/prismaClient";

// DESPUÉS:
import { readDb as prisma } from "../../../core/prismaReplica";
```

Este patrón requiere cero cambios en el resto del archivo.

### Archivos con migración completa

| Archivo | Motivo |
|---|---|
| `src/api/v1/services/dashboard.service.ts` | 100% lectura, 12+ queries paralelos |
| `src/api/v1/services/cierre.service.ts` | CTEs pesados + SET LOCAL statement_timeout |
| `src/api/v1/services/commissions.service.ts` | Lectura de políticas de comisiones |
| `src/api/v1/services/reports/loteriasReport.service.ts` | Reportes pesados |
| `src/api/v1/services/reports/vendedoresReport.service.ts` | Reportes pesados |
| `src/api/v1/services/reports/ventanasReport.service.ts` | Reportes pesados |
| `src/api/v1/services/accounts/accounts.queries.ts` | Raw SQL CTE + mv_daily_account_summary |
| `src/api/v1/services/accounts/accounts.balances.ts` | 4× $queryRaw secuenciales |
| `src/api/v1/services/accounts/accounts.service.ts` | Reads (writes viven en accounts.movements.ts) |

### sorteo.service.ts — Migración quirúrgica (dual import)

Este archivo mezcla writes (`evaluate`, `create`, `update`) y reads pesados
(`evaluatedSummary`, `groupedByLoteria`, `groupedByHour`).

```typescript
// Dual import al inicio del archivo:
import prisma from "../../../core/prismaClient";       // primary: writes
import { readDb } from "../../../core/prismaReplica";  // réplica: reads analíticos
```

Funciones migradas a `readDb`:
- `groupedByLoteria` — $queryRaw + sorteo.findMany
- `groupedByHour` — $queryRaw + sorteo.findMany
- `evaluatedSummary` Fase 1 — sorteo.findMany
- `evaluatedSummary` Fase 2 — jugada.findMany + 4× ticket.groupBy
- Queries acumulados — accountStatement.findMany + 2× findFirst
- Queries mensuales — sorteo.findMany + 2× ticket.groupBy + jugada.groupBy

Funciones que permanecen en `prisma` (primary):
- `create`, `update`, `open`, `evaluate` ($transaction masivo), `revertEvaluation`

### Archivos que NUNCA deben moverse a readDb

| Archivo | Motivo |
|---|---|
| `src/repositories/ticket.repository.ts` | Writes + calculateDynamicLimit en TX SERIALIZABLE |
| `src/api/v1/services/accounts/accounts.movements.ts` | registerPayment, reversePayment, deleteStatement |
| `sorteo.service.ts → evaluate()` | $transaction de evaluación masiva con ~10 modelos |

---

## Tests de verificación (src/scripts/test-replica.ts)

Script temporal para verificar la réplica. Ejecutar con:
```bash
NODE_ENV=development npx tsx src/scripts/test-replica.ts
```

Tests incluidos:
1. Ping básico (`SELECT NOW()`)
2. Vista materializada `mv_daily_account_summary` — verificar que existe en réplica
3. Proxy guard — bloquea writes en development
4. Replication lag estimado (`pg_last_xact_replay_timestamp`)
5. `SET LOCAL statement_timeout` dentro de `$transaction`

**Nota sobre el lag:** En idle (sin escrituras activas en primary), el lag puede mostrar
10-20s aunque la réplica esté al día. En producción con tráfico normal estará bajo 2s.

---

## Por qué falló el primer deploy en producción

El error fue `FATAL: Tenant or user not found` en Supabase.

**Causa:** `DATABASE_URL_REPLICA` fue configurado en Render con el username `postgres`
(recomendación incorrecta de ChatGPT) en lugar de `postgres.{project-ref}`.

El session pooler de Supabase requiere el project-ref en el username para enrutar
la conexión al proyecto correcto. Sin él, Supabase no puede identificar al tenant.

**Username correcto:** `postgres.xhwxiofujvoaszojcoml-rr-us-east-2-agaan`
**Username incorrecto:** `postgres`

---

## Checklist para re-implementar

- [ ] Crear `src/core/prismaReplica.ts` (contenido completo arriba)
- [ ] Agregar `DATABASE_URL_REPLICA` en `src/config/env.schema.ts`
- [ ] Agregar `DATABASE_URL_REPLICA` en `.env.example`
- [ ] Cambiar import en los 9 servicios de migración completa
- [ ] Aplicar dual-import en `sorteo.service.ts` (cambiar ~15 llamadas a `readDb`)
- [ ] Configurar `DATABASE_URL_REPLICA` en Render con username correcto (incluir project-ref)
- [ ] Ejecutar script de verificación antes del deploy
- [ ] Verificar que `mv_daily_account_summary` existe en la réplica de Supabase
