# RFC-001: Migración de `Jugada` Relacional a `jugadas_jsonb` en `Ticket`

**Estado:** APROBADO — Listo para ejecución de Fase 1 (Pre-requisito RFC-002 Completado)  
**Autor:** Arquitecto Senior (AI Analysis)  
**Fecha original:** 2026-08-27  
**Última actualización:** 2026-08-27  
**Versión:** 2.0  
**Codebase analizado:** `backend-bancas` (Node.js + TypeScript + Prisma + PostgreSQL + Redis)

---

## 📌 Estado de Pre-requisitos (Hitos Alcanzados)

> [!TIP]
> **HITO ALCANZADO (2026-08-27):**  
> 1. **Respaldos de Stored Procedures Nativo:** 19 funciones y procedimientos almacenados en PostgreSQL (incluyendo la función crítica `fn_evaluate_sorteo.sql`) fueron extraídos, respaldados y versionados en `docs/sql_legacy/`.
> 2. **Completada la Modularización RFC-002 (Patrón Facade):** El método monolítico `createOptimized` (~1,070 líneas) fue desacoplado exitosamente en **10 servicios de dominio independientes** (`src/services/ticket/`) con **0 errores de compilación TypeScript (`tsc --noEmit`)**.
> 
> **Impacto para la Migración JSONB:**  
> Gracias a RFC-002, la lógica de inserción relacional de `Jugada` ahora vive **exclusivamente dentro de [`TicketPersistenceService.ts`](file:///c:/Users/mquir/Proyectos/Bancas/backend/src/services/ticket/TicketPersistenceService.ts)** y el mapeo de respuesta para el Frontend dentro de [`TicketResponseBuilder.ts`](file:///c:/Users/mquir/Proyectos/Bancas/backend/src/services/ticket/TicketResponseBuilder.ts). La migración a JSONB **ya no requiere modificar la validación de riesgo (`TicketRiskValidator`), la concurrencia (`TicketConcurrencyManager`) ni las comisiones (`TicketCommissionCalculator`)**.

---

## Contexto y Motivación

La tabla `Jugada` es el corazón transaccional del sistema de lotería. Con el crecimiento en volumen de ventas, esta tabla acumula **millones de filas**, acaparando I/O de disco y ralentizando operaciones que van desde la creación de tickets hasta los reportes. Sus índices actuales son agresivos (`idx_jugada_maestro_final`, `idx_jugada_exclusiones_lookup`, etc.), lo que multiplica el costo de escritura en cada venta.

La propuesta es **eliminar la tabla `Jugada` como entidad relacional** y almacenar su detalle en un campo `jugadas_jsonb` (`jsonb`) dentro de `Ticket`, mientras se desacoplan las lecturas de reportes y dashboards de ese campo para no pagar el costo de escaneo JSONB.

---

## Análisis del Estado Actual (Hallazgos del Codebase)

| Componente | Situación actual |
|---|---|
| `Jugada` schema | 16 columnas relacionales + 6 índices compuestos. FK a `Ticket`, `Banca`, `LoteriaMultiplier`, `User`. |
| Motor de evaluación | `fn_evaluate_sorteo` — stored procedure PostgreSQL invocado vía `prisma.$queryRawUnsafe`. Respaldado y versionado en [`docs/sql_legacy/fn_evaluate_sorteo.sql`](file:///c:/Users/mquir/Proyectos/Bancas/backend/docs/sql_legacy/fn_evaluate_sorteo.sql). |
| Archivos de Persistencia Ticket | Desacoplados bajo `src/services/ticket/`. La inserción relacional actual vive exclusivamente en `TicketPersistenceService.ts`. |
| `DailyNumberSales` | **Incremental** — `incrementFromTicket` se llama dentro de la TX de creación. Actual JOIN depende de `Jugada`. |
| Redis | Cliente `ioredis` con circuit breaker. Manejado por `TicketRedisAccumulator.ts` en modo fire-and-forget. |
| `decrementFromTicket` | JOIN directo a `Jugada` para calcular el delta a restar cuando se cancela un ticket. |

---

## Pilar 1 — Diseño del Schema y Tipado (Prisma & TypeScript)

### 1.1 Estructura del JSONB: El "Clon Optimizado"

Se elimina la *grasa relacional* (PK, FKs, timestamps de auditoría) y se retienen los campos de **valor de negocio**:

```typescript
// src/services/ticket/types/jugada.jsonb.ts

import { BetType } from "../../../generated/prisma/client";

/**
 * Representación optimizada de una jugada almacenada en JSONB dentro de Ticket.
 * OMITE: id, ticketId, createdAt, updatedAt, deletedAt, deletedBy,
 *        deletedReason, excludedAt, excludedBy, excludedReason,
 *        commissionOrigin, commissionRuleId, multiplierId, bancaId
 */
export interface JugadaJsonb {
  // ── Identidad de la apuesta ──────────────────────
  type:             BetType;      // "NUMERO" | "REVENTADO"
  number:           string;       // Número apostado
  reventadoNumber?: string | null;// Solo si type = REVENTADO

  // ── Valores financieros ──────────────────────────
  amount:                 number; // Monto apostado
  finalMultiplierX:       number; // Multiplicador al momento de venta
  payout:                 number; // Premio calculado (0 si no ganó)
  commissionAmount:       number; // Comisión del vendedor
  listeroCommissionAmount:number; // Comisión del listero/ventana

  // ── Resultado de evaluación ───────────────────────
  isWinner:   boolean;
  isExcluded: boolean;
  isActive:   boolean; // Necesario para filtros de cancelación parcial
}

export type JugadaJsonbCreate = Omit<JugadaJsonb, 'isWinner' | 'payout'> & {
  isWinner:  false;
  payout:    0;
};
```

---

### 1.2 Integración en `TicketPersistenceService.ts` (Post-RFC-002)

Gracias al Facade implementado en RFC-002, la modificación del flujo de guardado en la base de datos se simplifica drásticamente. En lugar de hacer `tx.jugada.createMany`, `TicketPersistenceService.ts` insertará directamente el arreglo `jugadas_jsonb`:

```typescript
// src/services/ticket/TicketPersistenceService.ts (Fase 1 JSONB)

export class TicketPersistenceService {
  static async save(
    tx: Prisma.TransactionClient,
    context: TicketSaveContext
  ): Promise<TransactionSaveResult> {
    const { data, meta, ticketNumber, totalAmountTx, commissions, userId, options } = context;

    // Mapear jugadas a formato JSONB comprimido
    const jugadasJsonb: JugadaJsonbCreate[] = commissions.jugadasWithCommissions.map((j) => ({
      type: j.type,
      number: j.number,
      reventadoNumber: j.reventadoNumber ?? null,
      amount: j.amount,
      finalMultiplierX: j.finalMultiplierX,
      commissionAmount: j.commissionAmount,
      listeroCommissionAmount: j.listeroCommissionAmount,
      isWinner: false,
      payout: 0,
      isExcluded: false,
      isActive: true,
    }));

    const createdTicket = await tx.ticket.create({
      data: {
        ticketNumber,
        businessDate: meta.businessDateInfo.businessDate,
        bancaId: meta.bancaId,
        loteriaId: data.loteriaId,
        sorteoId: data.sorteoId,
        ventanaId: data.ventanaId,
        vendedorId: userId,
        totalAmount: totalAmountTx,
        totalCommission: commissions.totalCommission,
        totalListeroCommission: commissions.totalListeroCommission,
        status: TicketStatus.ACTIVE,
        isActive: true,
        clienteNombre: data.clienteNombre?.trim() || "CLIENTE CONTADO",
        jugadasJsonb: jugadasJsonb as unknown as Prisma.InputJsonValue,
      },
    });

    // Inserción relacional DUAL WRITE en Fase 2 (opcional/desactivable)
    // tx.jugada.createMany(...)

    await DailyNumberSalesService.incrementFromTicket(createdTicket.id, tx);

    return {
      createdTicketId: createdTicket.id,
      jugadasWithCommissions: commissions.jugadasWithCommissions,
      commissionsDetails: commissions.commissionsDetails,
      ticketNumber,
      warnings: context.warnings,
      seqForLog: context.seqForLog,
    };
  }
}
```

---

## Pilar 2 — Dashboards en Vivo y Reportes Históricos

### 2.1 El Problema Real
- **Dashboard en caliente** (minuto a minuto durante el sorteo) → Manejado por `TicketRedisAccumulator.ts` en Redis (`ioredis`), sin tocar PostgreSQL ni escarbar JSONB.
- **Reportes históricos post-sorteo** → Agregados en `DailyNumberSales`.

### 2.2 Reestructura de `DailyNumberSales` para JSONB

El método `DailyNumberSalesService.incrementFromTicket` usará `jsonb_array_elements` **únicamente sobre el ticket recién creado** (1 fila a la vez dentro de la TX de creación):

```sql
INSERT INTO "DailyNumberSales" (
  "id", "businessDate", "bancaId", "ventanaId", "vendedorId",
  "loteriaId", "sorteoId", "number", "type",
  "totalAmount", "ticketsCount", "jugadasCount"
)
SELECT
  gen_random_uuid(),
  t."businessDate",
  COALESCE(t."bancaId", 'da3545ac-fb10-4674-a345-6b66c9f89146'::uuid),
  t."ventanaId",
  t."vendedorId",
  t."loteriaId",
  t."sorteoId",
  j->>'number',
  (j->>'type')::"BetType",
  SUM((j->>'amount')::float),
  1,
  COUNT(*)::integer
FROM "Ticket" t,
     jsonb_array_elements(t."jugadas_jsonb") AS j
WHERE t.id = $1::uuid
  AND (j->>'isActive')::boolean = true
  AND (j->>'isExcluded')::boolean = false
GROUP BY
  t."businessDate", t."bancaId", t."ventanaId", t."vendedorId",
  t."loteriaId", t."sorteoId", j->>'number', (j->>'type')::"BetType"
ON CONFLICT ("businessDate", "sorteoId", "vendedorId", "number", "type")
DO UPDATE SET
  "totalAmount"  = "DailyNumberSales"."totalAmount"  + EXCLUDED."totalAmount",
  "ticketsCount" = "DailyNumberSales"."ticketsCount" + EXCLUDED."ticketsCount",
  "jugadasCount" = "DailyNumberSales"."jugadasCount" + EXCLUDED."jugadasCount";
```

---

## Pilar 3 — Refactor del Motor de Evaluación (Camino B en Node.js)

Con la lógica del stored procedure `fn_evaluate_sorteo.sql` ahora versionada en `docs/sql_legacy/`, el reemplazo se realiza mediante evaluación de batches en Node.js pasando a `SorteoRepository.evaluate`:

```typescript
// src/repositories/sorteo.repository.ts — evaluate() REFACTORIZADO

async evaluate(id: string, body: EvaluateBody) {
  const { winningNumber, extraMultiplierId, extraOutcomeCode } = body;

  const tickets = await prisma.ticket.findMany({
    where: {
      sorteoId: id,
      deletedAt: null,
      isActive: true,
      status: { in: [TicketStatus.ACTIVE, TicketStatus.EVALUATED] },
    },
    select: {
      id: true,
      jugadasJsonb: true,
      totalCommission: true,
      totalListeroCommission: true,
    },
  });

  let extraX = 0;
  if (extraMultiplierId) {
    const mul = await prisma.loteriaMultiplier.findUniqueOrThrow({
      where: { id: extraMultiplierId }, select: { valueX: true }
    });
    extraX = mul.valueX;
  }

  const BATCH_SIZE = 500;
  // Procesamiento de jugadasJsonb en memoria y persistencia masiva en batches...
}
```

---

## Pilar 4 — Plan de Ejecución (Zero Downtime)

### Fase 1: EXPAND — Agregar columna `jugadas_jsonb`
1. Ejecutar migración Prisma/SQL para agregar `jugadas_jsonb` a `Ticket`.
2. Actualizar `TicketPersistenceService.ts` para escribir en `jugadas_jsonb` (escritura dual o directa).
3. Actualizar `TicketResponseBuilder.ts` para mapear respuestas desde `jugadasJsonb`.

### Fase 2: MIGRATE — Backfill histórico
1. Ejecutar script de backfill offline para poblar `jugadas_jsonb` en tickets antiguos.
2. Migrar `DailyNumberSalesService` para leer de `jugadas_jsonb`.
3. Migrar `SorteoRepository.evaluate` al Camino B (Node.js).

### Fase 3: CONTRACT — Eliminar tabla `Jugada`
1. Verificar que `COUNT(*) WHERE jugadas_jsonb IS NULL` sea 0.
2. Ejecutar migración SQL `DROP TABLE "Jugada" CASCADE;`.

---

## Estimación Ajustada del Proyecto

- **Estado previo a RFC-002:** 4-6 semanas.
- **Estado actual (Post-RFC-002):** **1-2 semanas de ingeniería** (gracias a la arquitectura modular Facade ya desplegada).

---

*Documento actualizado y alineado con la arquitectura RFC-002 — 2026-08-27*
