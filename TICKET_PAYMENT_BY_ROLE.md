# 🎫 TicketPayment por Rol - Guía Exacta

**Qué enviar desde cada rol para registrar pagos (parciales y completos)**

---

## Requisitos de Request Body (Igual para Todos)

### Campos Requeridos
```javascript
{
  "ticketId": "550e8400-e29b-41d4-a716-446655440000"  // UUID del tiquete ganador
}
```

### Campos Opcionales
```javascript
{
  "amountPaid": 100.00,              // Monto a pagar (por default busca en DB)
  "method": "cash",                  // cash|check|transfer|system (default: cash)
  "notes": "comentario",             // Max 300 caracteres
  "isFinal": false,                  // true para finalizar pago parcial
  "idempotencyKey": "pago-123-456"   // 8-100 chars para reintentos idempotentes
}
```

### Headers (Requeridos)
```
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

---

## 🧑‍💼 VENDEDOR - Pagar Tiquetes Propios

### ¿Qué es?
Usuario que creó el tiquete y quiere cobrar su comisión.

### ¿Qué Puede Hacer?
- ✅ Registrar pagos en tiquetes **que él creó** (vendedorId = su userId)
- ✅ Pagos completos o parciales
- ✅ Ver historial de sus pagos
- ✅ Revertir sus propios pagos

### ¿Qué NO Puede Hacer?
- ❌ Pagar tiquete de otro vendedor
- ❌ Ver pagos de otros vendedores
- ❌ Revertir pago de otro vendedor

### Request Body - Pago Completo

**Escenario**: Tiquete gana $100, pagar todo

```javascript
POST /api/v1/ticket-payments
Authorization: Bearer <VENDEDOR_JWT>
Content-Type: application/json

{
  "ticketId": "550e8400-e29b-41d4-a716-446655440000",
  "amountPaid": 100,
  "method": "cash",
  "notes": "Pago completo del tiquete ganador"
}
```

**Response 201**:
```json
{
  "id": "payment-uuid",
  "ticketId": "550e8400-e29b-41d4-a716-446655440000",
  "amountPaid": 100,
  "isPartial": false,
  "remainingAmount": 0,
  "isFinal": false,
  "completedAt": "2025-10-28T15:30:00Z",
  "isReversed": false,
  "method": "cash",
  "notes": "Pago completo del tiquete ganador",
  "paidById": "vendedor-uuid"
}
```

✅ **Ticket.status**: PAID (automáticamente)

### Request Body - Pago Parcial ($30 de $100)

```javascript
POST /api/v1/ticket-payments
Authorization: Bearer <VENDEDOR_JWT>
Content-Type: application/json

{
  "ticketId": "550e8400-e29b-41d4-a716-446655440000",
  "amountPaid": 30,
  "method": "check",
  "notes": "Primera entrega, cheque",
  "idempotencyKey": "pago-vendedor-001"
}
```

**Response 201**:
```json
{
  "id": "payment-uuid",
  "amountPaid": 30,
  "isPartial": true,
  "remainingAmount": 70,
  "isFinal": false,
  "completedAt": null,
  "isReversed": false
}
```

✅ **Ticket.status**: EVALUATED (sin cambios - pendiente)

### Request Body - Finalizar Parcial ($70 restante)

```javascript
POST /api/v1/ticket-payments
Authorization: Bearer <VENDEDOR_JWT>
Content-Type: application/json

{
  "ticketId": "550e8400-e29b-41d4-a716-446655440000",
  "amountPaid": 50,           // < que lo que falta (70)
  "isFinal": true,           // ← MARCA COMO FINAL
  "notes": "Pago final, acepta $20 deuda",
  "idempotencyKey": "pago-vendedor-final"
}
```

**Response 201**:
```json
{
  "amountPaid": 50,
  "isPartial": true,
  "isFinal": true,
  "remainingAmount": 20,
  "completedAt": "2025-10-28T15:35:00Z"
}
```

✅ **Ticket.status**: PAID (con deuda aceptada)

### Error: Intentar Pagar Tiquete de Otro

```javascript
POST /api/v1/ticket-payments
Authorization: Bearer <VENDEDOR_JWT>
Content-Type: application/json

{
  "ticketId": "otro-vendedor-ticket-uuid",  // ❌ vendedorId ≠ mi userId
  "amountPaid": 100
}
```

**Response 403**:
```json
{
  "statusCode": 403,
  "code": "TKT_PAY_006",
  "message": "Unauthorized"
}
```

---

## 🏢 VENTANA - Pagar Tiquetes de su Ventana

### ¿Qué es?
Gerente/administrador de ventana que quiere registrar pagos de tiquetes creados por vendedores de su ventana.

### ¿Qué Puede Hacer?
- ✅ Registrar pagos en tiquetes **de su ventana** (ventanaId = su ventanaId)
- ✅ Pagos completos o parciales
- ✅ Ver historial de pagos de su ventana
- ✅ Revertir pagos de su ventana

### ¿Qué NO Puede Hacer?
- ❌ Pagar tiquete de otra ventana
- ❌ Ver pagos de otra ventana
- ❌ Revertir pago de otra ventana

### ⚠️ REQUISITO: JWT Must Include ventanaId

**El JWT del usuario VENTANA DEBE incluir:**
```json
{
  "id": "user-ventana-uuid",
  "role": "VENTANA",
  "ventanaId": "ventana-uuid"  // ← OBLIGATORIO
}
```

Si `ventanaId` es `null` o falta, recibirá error 403.

### Request Body - Pago Completo

```javascript
POST /api/v1/ticket-payments
Authorization: Bearer <VENTANA_JWT>
Content-Type: application/json

{
  "ticketId": "tiquete-de-mi-ventana-uuid",
  "amountPaid": 100,
  "method": "cash",
  "notes": "Pago completo registrado por ventana"
}
```

**Response 201**:
```json
{
  "amountPaid": 100,
  "isPartial": false,
  "remainingAmount": 0,
  "completedAt": "2025-10-28T16:00:00Z"
}
```

✅ **Ticket.status**: PAID

### Request Body - Pago Parcial

```javascript
POST /api/v1/ticket-payments
Authorization: Bearer <VENTANA_JWT>
Content-Type: application/json

{
  "ticketId": "tiquete-de-mi-ventana-uuid",
  "amountPaid": 40,
  "method": "transfer",
  "notes": "Transferencia de ventana",
  "idempotencyKey": "pago-ventana-001"
}
```

**Response 201**:
```json
{
  "amountPaid": 40,
  "isPartial": true,
  "remainingAmount": 60,
  "isFinal": false,
  "completedAt": null
}
```

✅ **Ticket.status**: EVALUATED (pendiente)

### Request Body - Finalizar Parcial

```javascript
POST /api/v1/ticket-payments
Authorization: Bearer <VENTANA_JWT>
Content-Type: application/json

{
  "ticketId": "tiquete-de-mi-ventana-uuid",
  "amountPaid": 60,
  "isFinal": true,
  "notes": "Pago final por ventana",
  "idempotencyKey": "pago-ventana-final"
}
```

**Response 201**:
```json
{
  "amountPaid": 60,
  "isPartial": true,
  "isFinal": true,
  "completedAt": "2025-10-28T16:05:00Z"
}
```

✅ **Ticket.status**: PAID

### Error: Sin ventanaId en JWT

```javascript
POST /api/v1/ticket-payments
Authorization: Bearer <VENTANA_JWT>  // ventanaId = null
Content-Type: application/json

{
  "ticketId": "tiquete-uuid",
  "amountPaid": 100
}
```

**Response 403**:
```json
{
  "statusCode": 403,
  "code": "TKT_PAY_006",
  "message": "Unauthorized"
}
```

**Solución**: Verificar que JWT incluye `ventanaId`

### Error: Tiquete de Otra Ventana

```javascript
POST /api/v1/ticket-payments
Authorization: Bearer <VENTANA_A_JWT>
Content-Type: application/json

{
  "ticketId": "tiquete-ventana-b-uuid",  // ❌ ventanaId ≠ mi ventanaId
  "amountPaid": 100
}
```

**Response 403**:
```json
{
  "statusCode": 403,
  "code": "TKT_PAY_006",
  "message": "Unauthorized"
}
```

---

## 👨‍💼 ADMIN - Pagar Cualquier Tiquete

### ¿Qué es?
Administrador global sin restricciones.

### ¿Qué Puede Hacer?
- ✅ Registrar pagos en **cualquier tiquete**
- ✅ Pagos completos o parciales
- ✅ Ver cualquier pago
- ✅ Revertir cualquier pago
- ✅ Sin validaciones de propiedad

### Request Body - Pago Completo (Cualquier Tiquete)

```javascript
POST /api/v1/ticket-payments
Authorization: Bearer <ADMIN_JWT>
Content-Type: application/json

{
  "ticketId": "tiquete-cualquiera-uuid",  // ✅ Cualquier tiquete
  "amountPaid": 100,
  "method": "cash",
  "notes": "Admin registra pago"
}
```

**Response 201**:
```json
{
  "amountPaid": 100,
  "isPartial": false,
  "remainingAmount": 0,
  "completedAt": "2025-10-28T16:10:00Z"
}
```

✅ **Ticket.status**: PAID

### Request Body - Pago Parcial

```javascript
POST /api/v1/ticket-payments
Authorization: Bearer <ADMIN_JWT>
Content-Type: application/json

{
  "ticketId": "tiquete-cualquiera-uuid",
  "amountPaid": 45,
  "notes": "Admin registra parcial",
  "idempotencyKey": "admin-pago-001"
}
```

**Response 201**:
```json
{
  "amountPaid": 45,
  "isPartial": true,
  "remainingAmount": 55,
  "completedAt": null
}
```

✅ **Ticket.status**: EVALUATED

### Request Body - Finalizar

```javascript
POST /api/v1/ticket-payments
Authorization: Bearer <ADMIN_JWT>
Content-Type: application/json

{
  "ticketId": "tiquete-cualquiera-uuid",
  "amountPaid": 30,
  "isFinal": true,
  "notes": "Admin finaliza con deuda",
  "idempotencyKey": "admin-final"
}
```

**Response 201**:
```json
{
  "amountPaid": 30,
  "isPartial": true,
  "isFinal": true,
  "completedAt": "2025-10-28T16:15:00Z"
}
```

✅ **Ticket.status**: PAID

---

## Tabla Comparativa - Request Body Requerido

| Campo | VENDEDOR | VENTANA | ADMIN |
|-------|----------|---------|-------|
| `ticketId` | ✅ UUID del tiquete propio | ✅ UUID del tiquete de ventana | ✅ UUID cualquiera |
| `amountPaid` | ✅ > 0, ≤ totalPayout | ✅ > 0, ≤ totalPayout | ✅ > 0, ≤ totalPayout |
| `method` | ❌ Opcional | ❌ Opcional | ❌ Opcional |
| `notes` | ❌ Opcional | ❌ Opcional | ❌ Opcional |
| `isFinal` | ❌ Opcional | ❌ Opcional | ❌ Opcional |
| `idempotencyKey` | ❌ Opcional | ❌ Opcional | ❌ Opcional |

**Nota**: El `ticketId` es el ÚNICO que diferencia por rol. El resto es igual.

---

## JWT Requirements

### VENDEDOR
```json
{
  "id": "vendedor-uuid",
  "role": "VENDEDOR",
  "ventanaId": "ventana-uuid"  // Puede estar presente o null
}
```
**Validación**: `ticket.vendedorId === JWT.id`

### VENTANA
```json
{
  "id": "user-ventana-uuid",
  "role": "VENTANA",
  "ventanaId": "ventana-uuid"  // ⚠️ OBLIGATORIO, no puede ser null
}
```
**Validación**: `JWT.ventanaId !== null && ticket.ventanaId === JWT.ventanaId`

### ADMIN
```json
{
  "id": "admin-uuid",
  "role": "ADMIN",
  "ventanaId": null  // Puede estar presente o null
}
```
**Validación**: Ninguna, acceso global

---

## Flujo de Pago Parcial Completo por Rol

### VENDEDOR: Paga su tiquete en 3 entregas

**T1: Primera entrega**
```javascript
POST /api/v1/ticket-payments
{
  "ticketId": "mi-tiquete",
  "amountPaid": 30
}
// Response: amountPaid=30, isPartial=true, Ticket=EVALUATED
```

**T2: Intento de segunda entrega (BLOQUEADO)**
```javascript
POST /api/v1/ticket-payments
{
  "ticketId": "mi-tiquete",
  "amountPaid": 40
}
// Response: 409 TKT_PAY_005 - Pago parcial pendiente
```

**T3: Finalizar con segunda entrega**
```javascript
POST /api/v1/ticket-payments
{
  "ticketId": "mi-tiquete",
  "amountPaid": 40,
  "isFinal": true
}
// Response: amountPaid=40, isFinal=true, Ticket=PAID
// Total pagado: 30 + 40 = 70 (con deuda de 30 aceptada)
```

### VENTANA: Paga tiquete de su ventana en 2 entregas

**T1: Primera entrega**
```javascript
POST /api/v1/ticket-payments
{
  "ticketId": "tiquete-ventana-mia",
  "amountPaid": 50
}
// Response: amountPaid=50, isPartial=true, Ticket=EVALUATED
```

**T2: Segunda entrega completa**
```javascript
POST /api/v1/ticket-payments
{
  "ticketId": "tiquete-ventana-mia",
  "amountPaid": 50  // Exactamente lo que falta
}
// Response: amountPaid=50, isPartial=false, Ticket=PAID
// (Automático porque 50 = resto exacto)
```

### ADMIN: Paga cualquier tiquete

Mismo flujo, sin restricciones de `ticketId`

---

## Errores Comunes y Soluciones

| Error | Causa | Solución |
|-------|-------|----------|
| 403 TKT_PAY_006 | Rol no autorizado O ventanaId null (VENTANA) | Verificar JWT, token correcto, ventanaId incluido |
| 403 TKT_PAY_006 | VENDEDOR intenta pagar otro vendedor | Enviar ticketId propio |
| 403 TKT_PAY_006 | VENTANA intenta pagar otra ventana | Enviar ticketId de su ventana |
| 404 TKT_PAY_001 | Tiquete no existe | Verificar ticketId |
| 409 TKT_PAY_002 | Tiquete no es ganador | Tiquete debe tener isWinner=true |
| 409 TKT_PAY_003 | Tiquete no está EVALUATED | Tiquete debe haber sido evaluado |
| 400 TKT_PAY_004 | amountPaid > totalPayout | Reducir monto |
| 409 TKT_PAY_005 | Pago parcial pendiente | Finalizar primero o pagar exacto |

---

## Resumen

**VENDEDOR**: `ticketId` debe ser tiquete que creó
**VENTANA**: `ticketId` debe ser tiquete de su ventana + JWT.ventanaId ≠ null
**ADMIN**: `ticketId` puede ser cualquiera

El resto del payload es **idéntico** para todos los roles.

