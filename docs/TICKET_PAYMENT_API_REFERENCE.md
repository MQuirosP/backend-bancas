# 📚 Referencia API - TicketPayment

**Quick Reference**: 5-minute read
**Actualizado**: 2025-10-28

---

## Tabla de Endpoints

| Método | Endpoint | Descripción | Auth |
|--------|----------|-------------|------|
| POST | `/ticket-payments` | Registrar pago | ✅ |
| GET | `/ticket-payments` | Listar pagos | ✅ |
| GET | `/ticket-payments/:id` | Detalle de pago | ✅ |
| PATCH | `/ticket-payments/:id` | Actualizar pago | ✅ |
| POST | `/ticket-payments/:id/reverse` | Revertir pago | ✅ |
| GET | `/tickets/:ticketId/payment-history` | Historial de tiquete | ✅ |

---

## 1. POST - Registrar Pago

```http
POST /api/v1/ticket-payments
Content-Type: application/json
Authorization: Bearer <token>
```

### Request

```json
{
  "ticketId": "550e8400-e29b-41d4-a716-446655440000",
  "amountPaid": 50.00,
  "method": "cash",
  "notes": "Pago contra entrega",
  "isFinal": false,
  "idempotencyKey": "pago-ticket-001-20251028"
}
```

### Request Schema

| Campo | Tipo | Requerido | Restricciones | Ejemplo |
|-------|------|-----------|---------------|---------|
| `ticketId` | UUID | ✅ | UUID válido | `550e8400-e29b-41d4-a716-446655440000` |
| `amountPaid` | number | ✅ | > 0, ≤ totalPayout | `50.00` |
| `method` | string | ❌ | cash\|check\|transfer\|system (default: cash) | `cash` |
| `notes` | string | ❌ | max 300 chars | `Pago primera entrega` |
| `isFinal` | boolean | ❌ | default: false | `false` |
| `idempotencyKey` | string | ❌ | 8-100 chars (reintento idempotente) | `pago-123-456` |

### Response 201 - Éxito

```json
{
  "id": "payment-uuid-12345",
  "ticketId": "550e8400-e29b-41d4-a716-446655440000",
  "amountPaid": 50.00,
  "isPartial": true,
  "remainingAmount": 50.00,
  "isFinal": false,
  "completedAt": null,
  "isReversed": false,
  "method": "cash",
  "notes": "Pago contra entrega",
  "paymentDate": "2025-10-28T20:38:41.123Z",
  "createdAt": "2025-10-28T20:38:41.123Z",
  "updatedAt": "2025-10-28T20:38:41.123Z",
  "paidBy": {
    "id": "user-uuid",
    "name": "María García",
    "email": "maria@example.com"
  }
}
```

### Response 400 - Validación

```json
{
  "statusCode": 400,
  "code": "VALIDATION_ERROR",
  "message": "amountPaid debe ser > 0",
  "details": {
    "field": "amountPaid",
    "code": "invalid_number",
    "issue": "Debe ser un número positivo"
  }
}
```

### Response 409 - Conflicto

```json
{
  "statusCode": 409,
  "code": "TKT_PAY_005",
  "message": "Ya existe un pago parcial pendiente. Finalícelo primero o pague el monto exacto."
}
```

### Response 403 - No Autorizado

```json
{
  "statusCode": 403,
  "code": "RBAC_001",
  "message": "No autorizado para registrar pago en esta ventana"
}
```

### Ejemplos de Uso

#### Pago Completo (100 de 100)

```bash
curl -X POST http://localhost:3000/api/v1/ticket-payments \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "ticketId": "550e8400-e29b-41d4-a716-446655440000",
    "amountPaid": 100.00,
    "method": "cash",
    "notes": "Pago completo"
  }'
```

#### Pago Parcial (30 de 100)

```bash
curl -X POST http://localhost:3000/api/v1/ticket-payments \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "ticketId": "550e8400-e29b-41d4-a716-446655440000",
    "amountPaid": 30.00,
    "method": "cash",
    "notes": "Primera entrega",
    "idempotencyKey": "pago-1-20251028"
  }'
```

#### Pago Final Parcial (50 de 100, acepta 50 de deuda)

```bash
curl -X POST http://localhost:3000/api/v1/ticket-payments \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "ticketId": "550e8400-e29b-41d4-a716-446655440000",
    "amountPaid": 50.00,
    "method": "check",
    "isFinal": true,
    "notes": "Pago final, acepta 50 deuda",
    "idempotencyKey": "pago-final-20251028"
  }'
```

---

## 2. GET - Listar Pagos

```http
GET /api/v1/ticket-payments?page=1&pageSize=20&status=partial
Authorization: Bearer <token>
```

### Query Parameters

| Parámetro | Tipo | Default | Valores | Descripción |
|-----------|------|---------|--------|-------------|
| `page` | int | 1 | ≥ 1 | Número de página |
| `pageSize` | int | 20 | 1-100 | Items por página |
| `ticketId` | UUID | - | UUID válido | Filtrar por tiquete |
| `ventanaId` | UUID | - | UUID válido | Filtrar por ventana (ADMIN) |
| `vendedorId` | UUID | - | UUID válido | Filtrar por vendedor |
| `status` | string | - | pending\|completed\|reversed\|partial | Estado del pago |
| `date` | string | today | today\|yesterday\|week\|month\|year\|range | Rango de fecha |
| `fromDate` | string | - | YYYY-MM-DD | Fecha inicial (si date=range) |
| `toDate` | string | - | YYYY-MM-DD | Fecha final (si date=range) |
| `sortBy` | string | createdAt | createdAt\|amountPaid\|updatedAt | Campo para ordenar |
| `sortOrder` | string | desc | asc\|desc | Orden ascendente/descendente |

### Response 200

```json
{
  "data": [
    {
      "id": "payment-uuid-1",
      "ticketId": "ticket-uuid",
      "amountPaid": 50.00,
      "isPartial": true,
      "remainingAmount": 50.00,
      "isFinal": false,
      "completedAt": null,
      "isReversed": false,
      "method": "cash",
      "paymentDate": "2025-10-28T20:38:41.123Z",
      "ticket": {
        "id": "ticket-uuid",
        "ticketNumber": "T250128-000001-AB",
        "ventana": {
          "id": "ventana-uuid",
          "name": "Ventana Centro"
        },
        "vendedor": {
          "id": "user-uuid",
          "name": "Juan Pérez"
        }
      },
      "paidBy": {
        "id": "user-uuid",
        "name": "María García"
      }
    }
  ],
  "meta": {
    "total": 150,
    "page": 1,
    "pageSize": 20,
    "totalPages": 8
  }
}
```

### Ejemplos

#### Listar Pagos Pendientes

```bash
curl "http://localhost:3000/api/v1/ticket-payments?status=pending&sortBy=createdAt&sortOrder=desc" \
  -H "Authorization: Bearer your-token"
```

#### Listar Pagos de Hoy

```bash
curl "http://localhost:3000/api/v1/ticket-payments?date=today" \
  -H "Authorization: Bearer your-token"
```

#### Listar Pagos de Rango

```bash
curl "http://localhost:3000/api/v1/ticket-payments?date=range&fromDate=2025-10-01&toDate=2025-10-28" \
  -H "Authorization: Bearer your-token"
```

---

## 3. GET - Detalle de Pago

```http
GET /api/v1/ticket-payments/:id
Authorization: Bearer <token>
```

### Path Parameters

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `id` | UUID | ID del pago |

### Response 200

```json
{
  "id": "payment-uuid",
  "ticketId": "ticket-uuid",
  "amountPaid": 50.00,
  "isPartial": true,
  "remainingAmount": 50.00,
  "isFinal": false,
  "completedAt": null,
  "isReversed": false,
  "method": "cash",
  "notes": "Pago contra entrega",
  "paymentDate": "2025-10-28T20:38:41.123Z",
  "createdAt": "2025-10-28T20:38:41.123Z",
  "updatedAt": "2025-10-28T20:38:41.123Z",
  "ticket": {
    "id": "ticket-uuid",
    "ticketNumber": "T250128-000001-AB",
    "totalAmount": 100.00,
    "status": "EVALUATED",
    "isWinner": true,
    "ventana": {
      "id": "ventana-uuid",
      "name": "Ventana Centro"
    },
    "vendedor": {
      "id": "user-uuid",
      "name": "Juan Pérez"
    },
    "sorteo": {
      "id": "sorteo-uuid",
      "number": "001",
      "drawDate": "2025-10-27T20:00:00Z"
    }
  },
  "paidBy": {
    "id": "user-uuid",
    "name": "María García",
    "email": "maria@example.com"
  }
}
```

### Ejemplo

```bash
curl http://localhost:3000/api/v1/ticket-payments/payment-uuid \
  -H "Authorization: Bearer your-token"
```

---

## 4. PATCH - Actualizar Pago

```http
PATCH /api/v1/ticket-payments/:id
Content-Type: application/json
Authorization: Bearer <token>
```

### Path Parameters

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `id` | UUID | ID del pago |

### Request

```json
{
  "isFinal": true,
  "notes": "Pago final actualizado"
}
```

### Request Schema

| Campo | Tipo | Requerido | Restricciones | Descripción |
|-------|------|-----------|---------------|-------------|
| `isFinal` | boolean | ❌ | - | Marcar pago parcial como final |
| `notes` | string | ❌ | max 300 chars | Actualizar notas |

### Response 200

```json
{
  "id": "payment-uuid",
  "ticketId": "ticket-uuid",
  "amountPaid": 30.00,
  "isPartial": true,
  "isFinal": true,
  "completedAt": "2025-10-28T20:45:00.123Z",
  "updatedAt": "2025-10-28T20:45:00.123Z"
}
```

### Ejemplo: Marcar Pago Parcial como Final

```bash
curl -X PATCH http://localhost:3000/api/v1/ticket-payments/payment-uuid \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "isFinal": true,
    "notes": "Pago final, acepta $20 de deuda"
  }'
```

---

## 5. POST - Revertir Pago

```http
POST /api/v1/ticket-payments/:id/reverse
Authorization: Bearer <token>
```

### Path Parameters

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `id` | UUID | ID del pago a revertir |

### Response 200

```json
{
  "id": "payment-uuid",
  "ticketId": "ticket-uuid",
  "isReversed": true,
  "reversedAt": "2025-10-28T20:50:00.123Z",
  "reversedBy": "user-uuid",
  "updatedAt": "2025-10-28T20:50:00.123Z"
}
```

### Response 409 - Ya Revertido

```json
{
  "statusCode": 409,
  "message": "El pago ya fue revertido"
}
```

### Ejemplo

```bash
curl -X POST http://localhost:3000/api/v1/ticket-payments/payment-uuid/reverse \
  -H "Authorization: Bearer your-token"
```

---

## 6. GET - Historial de Pago (Por Tiquete)

```http
GET /api/v1/tickets/:ticketId/payment-history
Authorization: Bearer <token>
```

### Path Parameters

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `ticketId` | UUID | ID del tiquete |

### Response 200

```json
{
  "ticketId": "ticket-uuid",
  "ticketNumber": "T250128-000001-AB",
  "totalPayout": 100.00,
  "totalPaid": 50.00,
  "remainingAmount": 50.00,
  "ticketStatus": "EVALUATED",
  "payments": [
    {
      "id": "payment-uuid-1",
      "amountPaid": 50.00,
      "isPartial": true,
      "remainingAmount": 50.00,
      "isFinal": false,
      "completedAt": null,
      "isReversed": false,
      "method": "cash",
      "paymentDate": "2025-10-28T20:38:41.123Z",
      "createdAt": "2025-10-28T20:38:41.123Z",
      "paidBy": {
        "id": "user-uuid",
        "name": "María García"
      }
    }
  ]
}
```

### Ejemplo

```bash
curl http://localhost:3000/api/v1/tickets/ticket-uuid/payment-history \
  -H "Authorization: Bearer your-token"
```

---

## Códigos de Error

### 4xx - Errores del Cliente

| Código HTTP | Code | Causa | Solución |
|-------------|------|-------|----------|
| 400 | VALIDATION_ERROR | Validación fallida | Verificar formato de datos |
| 400 | TKT_PAY_004 | Monto > totalPayout | Reducir monto |
| 401 | UNAUTHORIZED | Sin token/token inválido | Autenticar usuario |
| 403 | TKT_PAY_006 | Rol no autorizado | Solo ADMIN/VENTANA |
| 403 | RBAC_001 | Violación RBAC | VENTANA no puede pagar otra ventana |
| 404 | TKT_PAY_001 | Tiquete no existe | Verificar ID del tiquete |
| 404 | NOT_FOUND | Pago no existe | Verificar ID del pago |
| 409 | TKT_PAY_002 | Tiquete no es ganador | No puede pagar perdedor |
| 409 | TKT_PAY_003 | Estado no EVALUATED | Tiquete debe estar evaluado |
| 409 | TKT_PAY_005 | Pago parcial pendiente | Finalizar pago anterior |

### 5xx - Errores del Servidor

| Código HTTP | Causa | Acción |
|-------------|-------|--------|
| 500 | Error interno | Reintentar, contactar soporte |
| 503 | Servicio no disponible | Esperar y reintentar |

---

## Comportamiento Especial

### Idempotencia

Si envías el mismo `idempotencyKey`, devuelve el pago anterior:

```bash
# Primer intento
curl -X POST http://localhost:3000/api/v1/ticket-payments \
  -d '{
    "ticketId": "xxx",
    "amountPaid": 50,
    "idempotencyKey": "pago-123"
  }'
# → Respuesta 201 con pago ID=abc123

# Segundo intento con misma key (red falla en frontend)
curl -X POST http://localhost:3000/api/v1/ticket-payments \
  -d '{
    "ticketId": "xxx",
    "amountPaid": 50,
    "idempotencyKey": "pago-123"
  }'
# → Respuesta 201 con pago ID=abc123 (mismo, no duplica)
```

### Determinación Automática de isPartial

| Monto Pagado | Total Premio | isPartial | Status | Acción |
|--------------|--------------|-----------|--------|--------|
| 100 | 100 | false | → PAID | Automático |
| 50 | 100 | true | → EVALUATED | Pendiente |
| 50 + isFinal | 100 | true | → PAID | Con flag |
| 70 + 30 | 100 | false | → PAID | Automático |

### RBAC Automático

| Rol | Puede Ver | Puede Pagar |
|-----|-----------|-------------|
| ADMIN | Todos los pagos | Todos los tiquetes |
| VENTANA | Pagos de su ventana | Tiquetes de su ventana |
| VENDEDOR | ❌ NINGUNO | ❌ NINGUNO |

---

## Resumen de Ejemplos cURL

### 1. Crear pago completo

```bash
curl -X POST http://localhost:3000/api/v1/ticket-payments \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "ticketId": "550e8400-e29b-41d4-a716-446655440000",
    "amountPaid": 100
  }'
```

### 2. Crear pago parcial

```bash
curl -X POST http://localhost:3000/api/v1/ticket-payments \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "ticketId": "550e8400-e29b-41d4-a716-446655440000",
    "amountPaid": 30,
    "idempotencyKey": "pago-1"
  }'
```

### 3. Listar pagos

```bash
curl "http://localhost:3000/api/v1/ticket-payments?page=1&pageSize=20&status=partial" \
  -H "Authorization: Bearer $TOKEN"
```

### 4. Revertir pago

```bash
curl -X POST http://localhost:3000/api/v1/ticket-payments/payment-id/reverse \
  -H "Authorization: Bearer $TOKEN"
```

### 5. Historial de tiquete

```bash
curl http://localhost:3000/api/v1/tickets/ticket-id/payment-history \
  -H "Authorization: Bearer $TOKEN"
```

---

## Response Headers

```
Content-Type: application/json
X-Request-ID: uuid
X-Response-Time: 123ms
Cache-Control: no-cache
```

---

## Rate Limiting

- Sin límite por rol
- Sin limitación de tasa implementada actualmente
- Contactar a soporte si necesitas

---

## Notas Importantes

✅ **Siempre incluir Authorization header**
✅ **Usar idempotencyKey para reintentos**
✅ **VENTANA está auto-filtrada por su ventanaId**
✅ **Pago parcial bloquea segundo intento hasta finalizarse**
✅ **Transacciones atómicas: pago + status juntos**
✅ **Reversión es soft-delete (no borra registro)**

