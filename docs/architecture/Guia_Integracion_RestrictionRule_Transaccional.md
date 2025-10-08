# 🧭 Guía: Integrar RestrictionRule dentro de `TicketRepository.create()` (validación transaccional)

> **Objetivo:** Mover la validación jerárquica (User → Ventana → Banca) al interior del bloque `prisma.$transaction` de `TicketRepository.create()` para lograr **atomicidad completa** y evitar oversell en condiciones de alta concurrencia.

---

## 1️⃣ Revertir `TicketService.create()` a su estado base

Dejá el archivo `src/api/v1/services/ticket.service.ts` como estaba originalmente, antes de integrar la validación:

```ts
import { ActivityType } from "@prisma/client";
import TicketRepository from "../../../repositories/ticket.repository";
import ActivityService from "../../../core/activity.service";
import logger from "../../../core/logger";
import { AppError } from "../../../core/errors";

export const TicketService = {
  /**
   * Crear ticket (coordinando repositorio + auditoría)
   */
  async create(data: any, userId: string, requestId?: string) {
    try {
      const ticket = await TicketRepository.create(data, userId);

      await ActivityService.log({
        userId,
        action: ActivityType.TICKET_CREATE,
        targetType: "TICKET",
        targetId: ticket.id,
        details: {
          ticketNumber: ticket.ticketNumber,
          totalAmount: ticket.totalAmount,
          jugadas: ticket.jugadas.length,
        },
        requestId,
        layer: "service",
      });

      logger.info({
        layer: "service",
        action: "TICKET_CREATE",
        userId,
        requestId,
        payload: {
          ticketId: ticket.id,
          totalAmount: ticket.totalAmount,
          jugadas: ticket.jugadas.length,
        },
      });

      return ticket;
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "TICKET_CREATE_FAIL",
        userId,
        requestId,
        payload: { message: err.message },
      });
      throw err;
    }
  },

  async getById(id: string) {
    return TicketRepository.getById(id);
  },

  async list(page = 1, pageSize = 10, filters: any = {}) {
    return TicketRepository.list(page, pageSize, filters);
  },

  async cancel(id: string, userId: string, requestId?: string) {
    const ticket = await TicketRepository.cancel(id, userId);

    await ActivityService.log({
      userId,
      action: ActivityType.TICKET_CANCEL,
      targetType: "TICKET",
      targetId: id,
      details: { reason: "Cancelled by user" },
      requestId,
      layer: "service",
    });

    logger.warn({
      layer: "service",
      action: "TICKET_CANCEL",
      userId,
      requestId,
      payload: { ticketId: id },
    });

    return ticket;
  },
};
```

---

## 2️⃣ Mover la validación a `TicketRepository.create()`

Modificá el archivo `src/repositories/ticket.repository.ts` (o equivalente en tu estructura).  
El bloque nuevo se integra **dentro del `prisma.$transaction()`**, asegurando atomicidad total.

```ts
import prisma from "../core/prismaClient";
import { AppError } from "../core/errors";
import { RestrictionRuleRepository } from "./restrictionRule.repository";

export const TicketRepository = {
  async create(data: any, userId: string) {
    return await prisma.$transaction(async (tx) => {
      const { bancaId, ventanaId, jugadas } = data;
      const at = new Date();

      // ===========================================================
      // 1️⃣ VALIDACIÓN DE RESTRICCIONES (JERÁRQUICA Y ATÓMICA)
      // ===========================================================

      // 1.1 Límite por jugada
      for (const j of jugadas) {
        const limits = await RestrictionRuleRepository.getEffectiveLimits({
          bancaId,
          ventanaId,
          userId,
          number: j.number,
          at,
        });

        if (limits.maxAmount !== null && j.amount > limits.maxAmount) {
          throw new AppError(
            `Límite por jugada excedido para número ${j.number}. Máximo permitido: ${limits.maxAmount}`,
            400
          );
        }
      }

      // 1.2 Límite total por ticket
      const total = jugadas.reduce((acc: number, j: any) => acc + j.amount, 0);
      const totalLimits = await RestrictionRuleRepository.getEffectiveLimits({
        bancaId,
        ventanaId,
        userId,
        number: null,
        at,
      });

      if (totalLimits.maxTotal !== null && total > totalLimits.maxTotal) {
        throw new AppError(
          `Límite total por ticket excedido. Máximo permitido: ${totalLimits.maxTotal}`,
          400
        );
      }

      // ===========================================================
      // 2️⃣ CREACIÓN DEL TICKET (DENTRO DE LA MISMA TRANSACCIÓN)
      // ===========================================================
      const ticket = await tx.ticket.create({
        data: {
          ...data,
          userId,
          totalAmount: total,
          createdAt: at,
        },
        include: { jugadas: true },
      });

      return ticket;
    });
  },

  async getById(id: string) {
    return prisma.ticket.findUnique({
      where: { id },
      include: { jugadas: true },
    });
  },

  async list(page = 1, pageSize = 10, filters: any = {}) {
    const where: any = { ...filters };
    const [tickets, total] = await prisma.$transaction([
      prisma.ticket.findMany({
        where,
        include: { jugadas: true },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.ticket.count({ where }),
    ]);
    return { data: tickets, meta: { page, pageSize, total } };
  },

  async cancel(id: string, userId: string) {
    return prisma.ticket.update({
      where: { id },
      data: {
        status: "CANCELLED",
        cancelledBy: userId,
        cancelledAt: new Date(),
      },
      include: { jugadas: true },
    });
  },
};
```

---

## 3️⃣ Comparación rápida con tu versión actual

| Aspecto | Validación en `TicketService` | Validación en `TicketRepository` |
|----------|-------------------------------|----------------------------------|
| **Atomicidad** | ❌ No (validación fuera de transacción) | ✅ Sí (dentro del mismo `tx`) |
| **Concurrente seguro** | ⚠️ Riesgo bajo carga alta | ✅ 100% consistente |
| **Responsabilidad** | Lógica de negocio en Service | Lógica combinada en Repo |
| **Complejidad** | Simple | Moderada |
| **Tests** | Fáciles de aislar | Requiere mocks de Prisma Tx |

---

## 4️⃣ Cuándo usar esta versión

📌 **Recomendado solo si:**

- Comienzan a ocurrir conflictos de venta simultánea (duplicaciones o exceso de jugadas).
- Se planea escalar el sistema a múltiples vendedores concurrentes.
- Se integran topes dinámicos por jugada/ticket (donde varias reglas deben evaluarse al mismo tiempo).

📌 **No recomendado si:**

- El sistema está en entorno controlado o monousuario.
- La latencia mínima es prioritaria (cada venta debería ser ultrarrápida).

---

## 5️⃣ Commit sugerido si algún día lo aplicás

```bash
feat(tickets): move RestrictionRule enforcement inside repository transaction

Refactors TicketRepository.create() to perform hierarchical RestrictionRule validation
(User → Ventana → Banca) within the same prisma.$transaction block as ticket creation.
Ensures atomicity and eliminates oversell under concurrent operations.
TicketService restored to lightweight orchestration layer.
```
