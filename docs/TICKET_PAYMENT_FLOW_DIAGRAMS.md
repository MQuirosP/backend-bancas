# 📊 Diagramas de Flujos - TicketPayment

**Visualización de Flujos**: Estados, transiciones y decisiones
**Versión**: 1.0

---

## 1. Flujo General de Tiquete a Pago

```
┌─────────────────┐
│  TICKET CREADO  │
│    (ACTIVE)     │
└────────┬────────┘
         │
         ├─ Sorteo se ejecuta
         │
         ↓
┌──────────────────┐
│  TICKET EVALUADO │ ← Solo ganadores continúan aquí
│   (EVALUATED)    │
└────────┬─────────┘
         │
         ├─ ¿Es ganador?
         │  NO → CANCELLED
         │  YES ↓
         │
         ├────────────────────────────┬──────────────────────┐
         │                            │                      │
         ↓                            ↓                      ↓
    ┌─────────┐           ┌──────────────────┐    ┌──────────────────┐
    │  PAGO   │           │  PAGO PARCIAL    │    │ PAGO MÚLTIPLE    │
    │ COMPLETO│           │  (UNA ENTREGA)   │    │   (MÚLTIPLES)    │
    │ ($100)  │           │   ($30 de $100)  │    │    ($30 + $70)   │
    └────┬────┘           └────────┬─────────┘    └────────┬─────────┘
         │                         │                        │
         │ Registrar               │                        │
         │ amountPaid=$100         │                        │
         │                         │ Registrar              │
         │                         │ amountPaid=$30         │
         │                         │ isFinal=false          │
         │                         │                        │
         ↓                         ↓                        │
    ┌─────────┐          ┌──────────────────┐             │
    │  PAID   │◄─────┐   │   EVALUADO       │             │
    │ (status)│  YES │   │  (status)        │             │
    └─────────┘      │   │  Pending Payment │             │
                     │   └────────┬─────────┘             │
                     │            │                       │
                     │            ├─────────────┐         │
                     │            │             │         │
                     │     ¿Múltiples pagos?    │         │
                     │            │             │         │
                     │       NO ──┘             │         │
                     │       │                  │         │
                     │       │ Finalizar        │         │
                     │       │ (isFinal=true)   │ Pago siguiente
                     │       │ O pago exacto    │ o parcial final
                     │       │                  │         │
                     │       ↓                  ↓         │
                     │   ┌─────────┐      ┌─────────┐    │
                     └───│  PAID   │      │ EVALUATED◄───┘
                         │ (parcial)     │ (pendiente)
                         └─────────┘     └─────────┘
                             ▲               │
                             │ Pagar resto   │
                             │ exacto O      │
                             │ final         │
                             └───────────────┘

┌────────────────────────────────────────────────────────┐
│ TRANSICIONES FINALES:                                  │
│ - EVALUATED → PAID: Después de pago completo          │
│ - PAID → EVALUATED: Solo si se revierte pago          │
│ - Pago parcial: Ticket NO cambia a PAID (pendiente)   │
│ - Pago parcial + isFinal: Ticket → PAID (aceptado)    │
└────────────────────────────────────────────────────────┘
```

---

## 2. Máquina de Estados - TicketPayment

```
                    ┌─────────────────────────────┐
                    │   TICKET PAYMENT CREATED    │
                    │                             │
                    │  isReversed: false          │
                    │  isFinal: false             │
                    │  completedAt: null          │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────┴──────────┐
                    │                     │
                    ↓                     ↓
            ┌─────────────────┐  ┌──────────────┐
            │  PARTIAL PAY    │  │  FULL PAY    │
            │                 │  │              │
            │ isPartial: true │  │ isPartial:   │
            │ isFinal: false  │  │ false        │
            │ completedAt:    │  │ completedAt: │
            │   null          │  │   NOW        │
            │ Ticket: EVAL    │  │ Ticket: PAID │
            └────────┬────────┘  └──────────────┘
                     │                    ▲
                     │                    │
              ┌──────┴─────────────────────┘
              │
              ├─ Registrar otro pago
              │  (rechazado → error 409)
              │
              ├─ Pago exacto del resto
              │  ($70 final de $100)
              │  ↓
              │  ┌─────────────────┐
              │  │  FULL PAY       │
              │  │  (Completado)   │
              │  │  Ticket: PAID   │
              │  └─────────────────┘
              │
              ├─ Pago parcial + isFinal
              │  ($50 de $100)
              │  isFinal: true
              │  ↓
              │  ┌─────────────────┐
              │  │  PARTIAL FINAL  │
              │  │                 │
              │  │ isPartial: true │
              │  │ isFinal: true   │
              │  │ completedAt:    │
              │  │   NOW           │
              │  │ Ticket: PAID    │
              │  │ (con deuda)     │
              │  └─────────────────┘
              │
              └─ Revertir pago
                 ↓
              ┌──────────────────┐
              │  REVERSED        │
              │                  │
              │ isReversed: true │
              │ Ticket: EVAL     │
              │ (vuelve atrás)   │
              └──────────────────┘
```

---

## 3. Decisión: ¿Pago Parcial o Completo?

```
┌────────────────────────────────────┐
│ POST /ticket-payments              │
│ {                                  │
│   ticketId: "xxx"                  │
│   amountPaid: ???                  │
│ }                                  │
└────────────────────┬───────────────┘
                     │
        ┌────────────┴────────────┐
        │                         │
        ↓                         ↓
   ┌─────────────────┐    ┌────────────────┐
   │ Calcular        │    │ totalPayout =  │
   │ totalPayout     │    │ suma(jugadas   │
   │ (jugadas        │    │ ganadoras)     │
   │ ganadoras)      │    └────────────────┘
   └────────┬────────┘            │
            │◄───────────────────┘
            │
            │ Ejemplo: totalPayout = 100
            │
       ┌────┴────┐
       │          │
    amountPaid < totalPayout?
       │          │
      NO         YES
       │          │
       ↓          ↓
   ┌────────┐   ┌──────────┐
   │Completo│   │ Parcial  │
   │(100≡100)  │ (50<100) │
   └────┬───┘   └────┬─────┘
        │            │
        │     ¿isFinal?
        │     │       │
        │    YES      NO
        │     │       │
        │     ↓       ↓
        │  ┌────┐  ┌──────┐
        │  │PAID│  │EVAL  │
        │  └────┘  └──────┘
        │
        ↓
    ┌────────┐
    │ PAID   │
    │ Status │
    │Changed │
    └────────┘
```

---

## 4. Flujo de Error: Múltiples Parciales

```
┌──────────────────────────────────────────────────┐
│ Primer pago: $30 parcial registrado             │
│ Ticket.status: EVALUATED                        │
│ TicketPayment.isFinal: false                    │
└──────────────────────────────────────────────────┘
            │
            ↓
┌──────────────────────────────────────────────────┐
│ POST /ticket-payments (segundo intento)         │
│ {                                               │
│   ticketId: "same-ticket"                       │
│   amountPaid: 40                                │
│ }                                               │
└──────────────────────────────────────────────────┘
            │
            ↓
┌──────────────────────────────────────────────────┐
│ Backend busca:                                  │
│ .findFirst({                                   │
│   ticketId: xxx,                               │
│   isReversed: false,                           │
│   isFinal: false  ← AÚN NO FINALIZADO          │
│ })                                             │
│                                                 │
│ Encuentra: TicketPayment (isFinal=false)       │
└──────────────────────────────────────────────────┘
            │
            ↓
    ┌───────────────────────────────────────┐
    │ ERROR 409 - CONFLICT                  │
    │ TKT_PAY_005                           │
    │ "Ya existe un pago parcial pendiente" │
    └───────────────────────────────────────┘
            │
    ┌───────┴───────┐
    │               │
    ↓               ↓
 SOLUCIÓN 1     SOLUCIÓN 2
 ┌──────────┐  ┌──────────────────┐
 │ Pagar    │  │ Finalizar pago   │
 │ exacto   │  │ anterior PATCH    │
 │ ($70)    │  │ + nuevo pago     │
 │          │  │ (parcial o final)│
 └──────────┘  └──────────────────┘
      │               │
      ↓               ↓
   PAID            EVALUATED/PAID
```

---

## 5. Flujo de Reversión

```
┌────────────────────────────────────────┐
│ Pago Registrado y PAID                 │
│                                        │
│ TicketPayment.isReversed: false       │
│ TicketPayment.completedAt: 2025-10-28│
│ Ticket.status: PAID                   │
└────────────────────────────────────────┘
            │
            ↓
┌────────────────────────────────────────┐
│ POST /ticket-payments/:id/reverse      │
└────────────────────────────────────────┘
            │
            ↓
┌────────────────────────────────────────┐
│ TRANSACCIÓN:                           │
│ 1. Marcar TicketPayment.isReversed=true│
│ 2. Si Ticket.status === PAID:         │
│    Revertir a EVALUATED                │
│ 3. Registrar quién y cuándo            │
└────────────────────────────────────────┘
            │
            ↓
┌────────────────────────────────────────┐
│ POST-REVERSIÓN:                        │
│                                        │
│ TicketPayment.isReversed: true        │
│ TicketPayment.reversedAt: NOW         │
│ TicketPayment.reversedBy: user-id    │
│ Ticket.status: EVALUATED              │
│ (Vuelve pendiente de pago)            │
└────────────────────────────────────────┘
            │
            ↓
    ┌──────────────────────┐
    │ Puede registrar      │
    │ nuevo pago al ticket │
    └──────────────────────┘
```

---

## 6. Flujo de Idempotencia

```
┌──────────────────────────────────────────────┐
│ POST /ticket-payments                        │
│ {                                            │
│   ticketId: "xxx"                           │
│   amountPaid: 50                            │
│   idempotencyKey: "pago-ticket-001"         │
│ }                                           │
└───────────────┬────────────────────────────┘
                │
                ↓
        ┌──────────────────┐
        │ Buscar por key   │
        │ idempotencyKey = │
        │ "pago-ticket-001"│
        └────────┬─────────┘
                 │
         ┌───────┴───────┐
         │               │
       FOUND          NOT FOUND
         │               │
         ↓               ↓
    ┌─────────┐      ┌────────┐
    │Retornar │      │Crear   │
    │anterior │      │nuevo   │
    │(201)    │      │(201)   │
    └─────────┘      └────┬───┘
         │                │
         │ Mismo pago ID  │ Nuevo pago ID
         │                │
    ┌────┴────────────────┘
    │
    ↓
  ┌─────────────────────────────────┐
  │ Frontend recibe 201             │
  │ No duplica pago si reintenta    │
  │ ¡Idempotente! ✅               │
  └─────────────────────────────────┘
```

---

## 7. Secuencia: Pago Parcial Múltiple

```
Timeline: T1, T2, T3

T1: Primera entrega
┌─────────────────────────────────┐
│ POST /ticket-payments           │
│ amountPaid: 30 de 100           │
└──────────────┬──────────────────┘
               │
               ↓
        ┌──────────────────┐
        │ TicketPayment#1  │
        │ amountPaid: 30   │
        │ isPartial: true  │
        │ isFinal: false   │
        │ completedAt: null│
        │ Ticket: EVAL     │
        └──────────────────┘


T2: Intento de segunda entrega inmediata
┌─────────────────────────────────┐
│ POST /ticket-payments           │
│ amountPaid: 40 de 100           │
│ (sin isFinal)                   │
└──────────────┬──────────────────┘
               │
               ↓
        ❌ ERROR 409
        TKT_PAY_005
        "Pago parcial pendiente"


T3: Finalizar con segundo pago
┌──────────────────────────────────────┐
│ POST /ticket-payments                │
│ amountPaid: 70                       │
│ isFinal: true  ← MARCA COMO FINAL   │
└──────────────┬───────────────────────┘
               │
               ↓
        ┌──────────────────┐
        │ TicketPayment#2  │
        │ amountPaid: 70   │
        │ isPartial: true  │
        │ isFinal: true    │
        │ completedAt: NOW │
        │ Ticket: PAID     │◄── Cambio!
        └──────────────────┘


HISTORIAL FINAL:
┌─────────────────────────────────────┐
│ TicketPayment #1                    │
│ - $30 - parcial - no final - null   │
│                                     │
│ TicketPayment #2                    │
│ - $70 - parcial - final - 2025-10-28│
│                                     │
│ TOTAL PAGADO: $100                  │
│ TICKET STATUS: PAID (con deuda: $0) │
└─────────────────────────────────────┘
```

---

## 8. Matriz de Decisión: Qué Ocurre en Cada Caso

```
┌─────────────────────────────────────────────────────────────────┐
│                  MATRIZ DE DECISIÓN                             │
├─────────────────┬──────────┬──────────┬────────┬────────┬───────┤
│ amountPaid      │isPartial │isFinal   │ Status │Ticket  │Acción │
├─────────────────┼──────────┼──────────┼────────┼────────┼───────┤
│ = totalPayout   │ false    │ false    │201     │ PAID   │Listo  │
│ (ej: 100=100)   │          │ (ignored)│        │(auto)  │       │
├─────────────────┼──────────┼──────────┼────────┼────────┼───────┤
│ < totalPayout   │ true     │ false    │201     │ EVAL   │Pendto │
│ (ej: 30<100)    │          │          │        │(pendte)│       │
├─────────────────┼──────────┼──────────┼────────┼────────┼───────┤
│ < totalPayout   │ true     │ true     │201     │ PAID   │Final  │
│ (ej: 50<100)    │          │          │        │(aceptdo│parcial│
│ + isFinal       │          │          │        │deuda)  │       │
├─────────────────┼──────────┼──────────┼────────┼────────┼───────┤
│ exacto resto    │ false    │ false    │201     │ PAID   │Auto-  │
│ (despues 30+70) │          │ (ignored)│        │(auto)  │compl  │
│ = totalPayout   │          │          │        │        │       │
├─────────────────┼──────────┼──────────┼────────┼────────┼───────┤
│ > totalPayout   │ N/A      │ N/A      │400     │ N/A    │Rechzo │
│ (ej: 150>100)   │          │          │        │        │       │
├─────────────────┼──────────┼──────────┼────────┼────────┼───────┤
│ existe parcial  │ N/A      │ N/A      │409     │ N/A    │Bloq   │
│ sin cerrar      │          │          │        │        │       │
├─────────────────┼──────────┼──────────┼────────┼────────┼───────┤

Notas:
- status = HTTP response code
- Ticket status = Ticket.status después de operación
- isFinal en pago completo es ignorado (no aplica)
- Pago parcial bloquea segundo intento hasta finalización
```

---

## 9. Flujo de Roles y Autorización

```
┌──────────────────────────────────────┐
│ POST /ticket-payments                │
│ + Authorization: Bearer <token>      │
└──────────────┬───────────────────────┘
               │
               ↓
        ┌─────────────────┐
        │ Extraer role    │
        │ del JWT token   │
        └────────┬────────┘
                 │
      ┌──────────┼──────────┐
      │          │          │
     ADMIN    VENTANA    VENDEDOR
      │          │          │
      ↓          ↓          ↓
    ✅          ✅          ❌
    Sí          Sí          NO
   Crear       Crear       Crear
   pagos       pagos        pagos
   cualquier   su
   tiquete     ventana

┌─────────────────────────────────────┐
│ VENTANA ESPECÍFICO:                │
│                                    │
│ Ticket.ventanaId !== JWT.ventanaId?│
│            │                       │
│           YES                      │
│            │                       │
│            ↓                       │
│   ❌ 403 RBAC_001                 │
│   "No autorizado para esta ventana"│
└─────────────────────────────────────┘
```

---

## 10. Secuencia Temporal Completa

```
Timeline completa de un tiquete con múltiples pagos:

00:00 - Tiquete creado
        Ticket.status = ACTIVE

01:00 - Sorteo se ejecuta
        Ticket evaluado como ganador
        Ticket.status = EVALUATED
        Ticket.isWinner = true
        totalPayout = 100

02:00 - Primer pago ($30)
        POST /ticket-payments
        ✅ TicketPayment#1 creado
           amountPaid: 30
           isPartial: true
           completedAt: null
        📍 Ticket.status = EVALUATED (sin cambios)

02:30 - Intento de segundo pago sin cerrar ($40)
        POST /ticket-payments
        ❌ ERROR 409 TKT_PAY_005
        "Debe finalizar pago anterior"

03:00 - Finalizar pago 1 + hacer pago 2 ($70 final)
        POST /ticket-payments
        + isFinal: true
        ✅ TicketPayment#2 creado
           amountPaid: 70
           isFinal: true
           completedAt: 2025-10-28T03:00:00Z
        📍 Ticket.status = PAID ← ¡CAMBIO!

03:30 - Revisar historial
        GET /tickets/xxx/payment-history

        Respuesta:
        {
          totalPayout: 100,
          totalPaid: 100,
          remainingAmount: 0,
          ticketStatus: "PAID",
          payments: [
            { amountPaid: 30, isPartial: true, isFinal: false, ... },
            { amountPaid: 70, isPartial: true, isFinal: true, ... }
          ]
        }

04:00 - Detectan error en segundo pago
        POST /ticket-payments/:id/reverse

        ✅ TicketPayment#2 revertido
           isReversed: true
           reversedAt: 2025-10-28T04:00:00Z
        📍 Ticket.status = EVALUATED ← Vuelve atrás

04:30 - Pago correcto ($70)
        POST /ticket-payments
        + isFinal: true
        ✅ TicketPayment#3 creado
        📍 Ticket.status = PAID ← De nuevo

05:00 - Fin
        Tiquete completamente pagado
```

---

## Resumen Visual

| Flujo | Complejidad | Casos |
|-------|------------|-------|
| Pago Completo | ⭐ Baja | 1 POST → PAID |
| Pago Parcial Único | ⭐⭐ Media | 1 POST → EVAL (pendiente) |
| Múltiples Parciales | ⭐⭐⭐ Alta | Bloqueo + finalización |
| Reversión | ⭐⭐ Media | POST reverse → estado anterior |
| Idempotencia | ⭐⭐⭐ Alta | Retry-safe con key |

---

**Todos los flujos son:**
✅ Atómicos (transaccionalidad Prisma)
✅ Auditados (ActivityService)
✅ RBAC-protegidos
✅ Validados estrictamente
✅ Production-ready

