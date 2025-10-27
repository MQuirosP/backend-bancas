# Frontend Integration Guide

**Backend Version**: 1.0.0
**API Base URL**: `/api/v1`
**Status**: ✅ Ready for Integration
**Date**: 2025-10-27

---

## Quick Start

### Environment Variables
```env
VITE_API_BASE_URL=http://localhost:3000/api/v1
```

### Authentication
All endpoints require JWT in Authorization header:
```
Authorization: Bearer {token}
```

The token contains:
- `userId`: User UUID
- `role`: ADMIN | VENTANA | VENDEDOR
- `ventanaId`: Ventana UUID (only if VENTANA/VENDEDOR role)

---

## Ticket Payment Module

### 1. Fetch Pending Winning Tickets

**Request**:
```typescript
GET /api/v1/tickets?status=EVALUATED&isWinner=true&ventanaId={optional}
```

**Response**:
```json
{
  "data": [
    {
      "id": "uuid",
      "ticketNumber": "TKT-2025-001234",
      "status": "EVALUATED",
      "isWinner": true,
      "totalAmount": 100,
      "createdAt": "2025-10-27T14:00:00Z",
      "jugadas": [
        {
          "id": "uuid",
          "number": "25",
          "amount": 50,
          "payout": 2000,
          "isWinner": true,
          "finalMultiplierX": 1.5
        }
      ],
      "ventana": { "id", "name" },
      "sorteo": { "id", "name", "scheduledAt" }
    }
  ]
}
```

### 2. Create Payment

**Request**:
```typescript
POST /api/v1/ticket-payments
Content-Type: application/json

{
  "ticketId": "uuid",
  "amountPaid": 1500.00,
  "method": "cash",
  "notes": "Pago parcial - cliente sin dinero hoy",
  "isFinal": false,
  "idempotencyKey": "unique-key-12345"
}
```

**Response** (201 Created):
```json
{
  "id": "uuid",
  "ticketId": "uuid",
  "amountPaid": 1500.00,
  "isPartial": true,
  "remainingAmount": 500.00,
  "isFinal": false,
  "completedAt": null,
  "method": "cash",
  "notes": "Pago parcial",
  "paidBy": {
    "id": "uuid",
    "name": "Juan Admin"
  },
  "ticket": {
    "id": "uuid",
    "ticketNumber": "TKT-2025-001234",
    "status": "EVALUATED",
    "totalWinnersPayout": 2000.00
  },
  "createdAt": "2025-10-27T14:30:00Z",
  "updatedAt": "2025-10-27T14:30:00Z"
}
```

**Error Responses**:
- `400`: Amount exceeds payout, validation errors
- `403`: Unauthorized role/ventana
- `404`: Ticket not found
- `409`: Ticket not winner/evaluated, payment already exists

### 3. Mark Partial Payment as Final

**Request**:
```typescript
PATCH /api/v1/ticket-payments/{paymentId}
Content-Type: application/json

{
  "isFinal": true,
  "notes": "Payment finalized - customer accepted partial"
}
```

**Response** (200 OK):
```json
{
  "id": "uuid",
  "ticketId": "uuid",
  "amountPaid": 1500.00,
  "isFinal": true,
  "completedAt": "2025-10-27T14:35:00Z",
  "ticket": {
    "id": "uuid",
    "status": "PAGADO"  // ← Status updated!
  },
  ...
}
```

### 4. Get Payment History for Ticket

**Request**:
```typescript
GET /api/v1/tickets/{ticketId}/payment-history
```

**Response** (200 OK):
```json
{
  "ticketId": "uuid",
  "ticketNumber": "TKT-2025-001234",
  "totalPayout": 2000.00,
  "totalPaid": 1500.00,
  "remainingAmount": 500.00,
  "ticketStatus": "EVALUATED",
  "payments": [
    {
      "id": "uuid",
      "amountPaid": 1000.00,
      "method": "cash",
      "paidBy": { "id", "name" },
      "paidAt": "2025-10-27T14:30:00Z",
      "isPartial": true,
      "isFinal": false,
      "isReversed": false
    },
    {
      "id": "uuid",
      "amountPaid": 500.00,
      "method": "check",
      "paidBy": { "id", "name" },
      "paidAt": "2025-10-27T15:00:00Z",
      "isPartial": false,
      "isFinal": true,
      "completedAt": "2025-10-27T15:00:00Z",
      "isReversed": false
    }
  ]
}
```

### 5. Reverse Payment

**Request**:
```typescript
POST /api/v1/ticket-payments/{paymentId}/reverse
```

**Response** (200 OK):
```json
{
  "id": "uuid",
  "ticketId": "uuid",
  "isReversed": true,
  "reversedAt": "2025-10-27T14:40:00Z",
  "reversedBy": {
    "id": "uuid",
    "name": "Admin User"
  },
  "ticket": {
    "id": "uuid",
    "status": "EVALUATED"  // ← Reverted from PAGADO
  }
}
```

### 6. List Payments (with Filters)

**Request**:
```typescript
GET /api/v1/ticket-payments?page=1&pageSize=20&status=pending&fromDate=2025-10-20&toDate=2025-10-27
```

**Query Parameters**:
```
page: int (default: 1)
pageSize: int 1-100 (default: 20)
ticketId: UUID (optional)
ventanaId: UUID (optional, ADMIN only)
vendedorId: UUID (optional, ADMIN only)
status: 'pending'|'completed'|'reversed'|'partial' (optional)
fromDate: 'YYYY-MM-DD' (optional)
toDate: 'YYYY-MM-DD' (optional)
sortBy: 'createdAt'|'amountPaid'|'updatedAt' (default: createdAt)
sortOrder: 'asc'|'desc' (default: desc)
```

**Response** (200 OK):
```json
{
  "data": [
    {
      "id": "uuid",
      "ticketNumber": "TKT-2025-001234",
      "amountPaid": 1500.00,
      "totalPayout": 2000.00,
      "isPartial": true,
      "isFinal": false,
      "method": "cash",
      "paidByUser": { "id", "name" },
      "createdAt": "2025-10-27T14:30:00Z"
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

---

## Dashboard Module

### 1. Get Main Dashboard

**Request**:
```typescript
GET /api/v1/admin/dashboard?timeframe=today&scope=all&ventanaId={optional}
```

**Query Parameters**:
```
timeframe: 'today'|'thisWeek'|'thisMonth'|'thisYear'|'custom' (default: today)
fromDate: 'YYYY-MM-DD' (required if timeframe=custom)
toDate: 'YYYY-MM-DD' (required if timeframe=custom)
ventanaId: UUID (optional, ADMIN only)
scope: 'all'|'byVentana' (default: all)
```

**Response** (200 OK):
```json
{
  "data": {
    "ganancia": {
      "totalAmount": 1234567.00,
      "byVentana": [
        {
          "ventanaId": "uuid",
          "ventanaName": "Ventana A",
          "amount": 234567.00
        }
      ],
      "byLoteria": [
        {
          "loteriaId": "uuid",
          "loteriaName": "Diario",
          "amount": 1234567.00
        }
      ]
    },
    "cxc": {
      "totalAmount": 567890.00,
      "byVentana": [
        {
          "ventanaId": "uuid",
          "ventanaName": "Ventana A",
          "totalSales": 100000,
          "totalPaidOut": 43210,
          "amount": 56790
        }
      ]
    },
    "cxp": {
      "totalAmount": 45123.00,
      "byVentana": [
        {
          "ventanaId": "uuid",
          "ventanaName": "Ventana B",
          "totalWinners": 120000,
          "totalPaidOut": 125000,
          "amount": 5000
        }
      ]
    },
    "summary": {
      "totalSales": 5000000.00,
      "totalPayouts": 2500000.00,
      "totalCommissions": 1234567.00,
      "totalTickets": 15000,
      "winningTickets": 3500
    }
  },
  "meta": {
    "range": {
      "fromAt": "2025-10-27T00:00:00Z",
      "toAt": "2025-10-27T23:59:59Z",
      "tz": "America/Costa_Rica"
    },
    "scope": "all",
    "generatedAt": "2025-10-27T14:35:00Z"
  }
}
```

### 2. Get Ganancia (Profit) Details

**Request**:
```typescript
GET /api/v1/admin/dashboard/ganancia?timeframe=thisMonth&ventanaId={optional}
```

**Response** (200 OK):
```json
{
  "data": {
    "totalAmount": 1234567.00,
    "byVentana": [...],
    "byLoteria": [...]
  },
  "meta": { ... }
}
```

### 3. Get CxC (Receivables) Details

**Request**:
```typescript
GET /api/v1/admin/dashboard/cxc?timeframe=thisMonth&ventanaId={optional}
```

**Response** (200 OK):
```json
{
  "data": {
    "totalAmount": 567890.00,
    "byVentana": [
      {
        "ventanaId": "uuid",
        "ventanaName": "Ventana A",
        "totalSales": 100000,
        "totalPaidOut": 43210,
        "amount": 56790
      }
    ]
  },
  "meta": { ... }
}
```

### 4. Get CxP (Payables) Details

**Request**:
```typescript
GET /api/v1/admin/dashboard/cxp?timeframe=thisMonth&ventanaId={optional}
```

**Response** (200 OK):
```json
{
  "data": {
    "totalAmount": 45123.00,
    "byVentana": [
      {
        "ventanaId": "uuid",
        "ventanaName": "Ventana B",
        "totalWinners": 120000,
        "totalPaidOut": 125000,
        "amount": 5000
      }
    ]
  },
  "meta": { ... }
}
```

---

## RBAC Rules

### Ticket Payments

| Operation | ADMIN | VENTANA | VENDEDOR |
|-----------|-------|---------|----------|
| Create | ✅ Any | ✅ Own ventana | ❌ Forbidden |
| List | ✅ All | ✅ Own ventana | ❌ Forbidden |
| Get details | ✅ Any | ✅ Own ventana | ❌ Forbidden |
| Update | ✅ Any | ✅ Own ventana | ❌ Forbidden |
| Reverse | ✅ Any | ✅ Own ventana | ❌ Forbidden |
| History | ✅ Any | ✅ Own ventana | ❌ Forbidden |

### Dashboard

| Operation | ADMIN | VENTANA | VENDEDOR |
|-----------|-------|---------|----------|
| View main | ✅ Global | ✅ Own only | ❌ Forbidden |
| Ganancia | ✅ Global | ✅ Own only | ❌ Forbidden |
| CxC | ✅ Global | ✅ Own only | ❌ Forbidden |
| CxP | ✅ Global | ✅ Own only | ❌ Forbidden |

**Note**: When VENTANA user is logged in, `ventanaId` parameter is ignored and auto-set to their own ventanaId.

---

## Data Types

### Payment Status
- `pending`: Payment not yet completed or finalized
- `completed`: Payment is finalized (isFinal=true)
- `reversed`: Payment has been reversed
- `partial`: Payment is partial but not finalized

### Ticket Status
- `ACTIVE`: Ticket sold, awaiting draw
- `EVALUATED`: Draw completed, awaiting payment
- `PAGADO`: Payment completed (full or final partial) ← NEW
- `CANCELLED`: Ticket cancelled
- `RESTORED`: Ticket restored from cancellation

### Payment Methods
- `cash`: Cash payment
- `check`: Check payment
- `transfer`: Bank transfer
- `system`: System payment (admin/automatic)

### Timeframes
- `today`: Current day (CR timezone)
- `thisWeek`: Current calendar week
- `thisMonth`: Current calendar month
- `thisYear`: Current calendar year
- `custom`: Custom date range (requires fromDate/toDate)

---

## Common Workflows

### Workflow 1: Complete Single Ticket Payment

```typescript
// 1. Get ticket details
const ticket = await fetch('/api/v1/tickets/{id}').then(r => r.json());

// 2. Display payout info
console.log(`Total payout: ¢${ticket.totalWinnersPayout}`);

// 3. Create payment (full amount)
const payment = await fetch('/api/v1/ticket-payments', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    ticketId: ticket.id,
    amountPaid: ticket.totalWinnersPayout,
    method: 'cash',
    idempotencyKey: generateUUID()
  })
}).then(r => r.json());

// 4. Verify ticket now has PAGADO status
console.log(`Ticket status: ${payment.ticket.status}`); // PAGADO
```

### Workflow 2: Partial Payment with Future Completion

```typescript
// 1. Create partial payment
const payment1 = await fetch('/api/v1/ticket-payments', {
  method: 'POST',
  body: JSON.stringify({
    ticketId: ticket.id,
    amountPaid: 1000, // Partial
    method: 'cash',
    isFinal: false,
    idempotencyKey: 'partial-1'
  })
}).then(r => r.json());

console.log(`Remaining: ¢${payment1.remainingAmount}`); // ¢1000

// 2. Later... Complete the payment
const payment2 = await fetch('/api/v1/ticket-payments', {
  method: 'POST',
  body: JSON.stringify({
    ticketId: ticket.id,
    amountPaid: 1000, // Rest of the amount
    method: 'check',
    isFinal: true,
    idempotencyKey: 'partial-2'
  })
}).then(r => r.json());

console.log(`Ticket status: ${payment2.ticket.status}`); // PAGADO
```

### Workflow 3: Partial Payment with Accepted Loss

```typescript
// Customer owes ¢2000 but will only pay ¢1500
const payment = await fetch('/api/v1/ticket-payments', {
  method: 'POST',
  body: JSON.stringify({
    ticketId: ticket.id,
    amountPaid: 1500,
    method: 'cash',
    isFinal: true,  // ← Mark as final immediately
    notes: 'Customer accepted ¢500 loss',
    idempotencyKey: 'final-partial'
  })
}).then(r => r.json());

// Even though it's partial, status is PAGADO
console.log(`Status: ${payment.ticket.status}`); // PAGADO
console.log(`Accepted loss: ¢${payment.remainingAmount}`); // ¢500
```

### Workflow 4: Dashboard Filters

```typescript
// Today's dashboard
const today = await fetch('/api/v1/admin/dashboard?timeframe=today').then(r => r.json());

// This week
const thisWeek = await fetch('/api/v1/admin/dashboard?timeframe=thisWeek').then(r => r.json());

// Custom range
const custom = await fetch(
  `/api/v1/admin/dashboard?timeframe=custom&fromDate=2025-10-20&toDate=2025-10-27`
).then(r => r.json());

// Specific ventana (ADMIN only)
const ventanaMetrics = await fetch(
  `/api/v1/admin/dashboard?timeframe=today&ventanaId=uuid-123`
).then(r => r.json());
```

---

## Error Handling

### Common Errors

```json
{
  "error": "TKT_PAY_001",
  "message": "Tiquete no encontrado",
  "status": 404
}
```

### List of Error Codes

| Code | Status | Message | Solution |
|------|--------|---------|----------|
| TKT_PAY_001 | 404 | Ticket not found | Verify ticketId |
| TKT_PAY_002 | 409 | Not a winner | Verify isWinner=true |
| TKT_PAY_003 | 409 | Not yet evaluated | Wait for sorteo evaluation |
| TKT_PAY_004 | 400 | Amount exceeds payout | Reduce amountPaid |
| TKT_PAY_005 | 409 | Payment already exists | Check payment history |
| TKT_PAY_006 | 403 | Unauthorized | Check user role/ventana |
| TKT_PAY_007 | 409 | Idempotency conflict | Use unique idempotencyKey |

---

## Frontend Implementation Checklist

### Ticket Payment Form
- [ ] Fetch ticket with jugadas/winners
- [ ] Display total payout amount
- [ ] Input field for payment amount
- [ ] Validate amount > 0 and ≤ payout
- [ ] Payment method selector (cash/check/transfer/system)
- [ ] Optional notes textarea
- [ ] Optional "Mark as final" checkbox
- [ ] Generate idempotencyKey (UUID)
- [ ] Show loading state during submission
- [ ] Handle error responses with user-friendly messages
- [ ] Show success confirmation
- [ ] Display remaining amount if partial

### Bulk Payment Form
- [ ] Multi-select tickets from list
- [ ] Show total payout for selected tickets
- [ ] Options: pay full amount vs. custom distribution
- [ ] Support equal distribution of partial amount
- [ ] Summary table before submission
- [ ] Submit multiple payments in sequence
- [ ] Show progress/success for each payment

### Payment History View
- [ ] Fetch payment history for ticket
- [ ] Display chronological list of payments
- [ ] Show totals: paidOut, remaining
- [ ] Show completed date if PAGADO
- [ ] Edit/reverse action buttons
- [ ] Print/export history

### Dashboard Views
- [ ] Implement metric cards (Ganancia, CxC, CxP)
- [ ] Display trend indicators
- [ ] Show breakdown tables (by ventana, by lotería)
- [ ] Implement charts (Recharts recommended)
- [ ] Filter by timeframe
- [ ] Filter by ventana (ADMIN only)
- [ ] Export/print functionality
- [ ] Loading states and error handling
- [ ] Real-time refresh option

### State Management
- [ ] Create Zustand store for payment state
- [ ] Track selectedTickets
- [ ] Track currentPayment form data
- [ ] Track isLoading, isSubmitting states
- [ ] Track errors and success messages
- [ ] Implement undo/retry logic

---

## Testing Examples

### Create Payment (Success)
```bash
curl -X POST http://localhost:3000/api/v1/ticket-payments \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "ticketId": "550e8400-e29b-41d4-a716-446655440000",
    "amountPaid": 1500.00,
    "method": "cash",
    "notes": "Test payment",
    "isFinal": false,
    "idempotencyKey": "test-12345"
  }'
```

### Create Payment (Invalid Token)
```bash
curl -X POST http://localhost:3000/api/v1/ticket-payments \
  -H "Authorization: Bearer invalid" \
  -H "Content-Type: application/json" \
  -d '...'

# Response: 401 Unauthorized
```

### Get Dashboard
```bash
curl -X GET "http://localhost:3000/api/v1/admin/dashboard?timeframe=today" \
  -H "Authorization: Bearer {token}"
```

---

## Notes for Implementation Team

1. **Always use idempotencyKey**: Generate unique key per payment request to ensure safety on retries
2. **Handle timeframe conversions**: Convert CR timezone dates properly in your frontend (use date-fns or moment)
3. **Show remaining amount**: After partial payment, display `remainingAmount` to customer
4. **Status polling**: After payment creation, you may need to poll ticket status (though it updates immediately)
5. **RBAC is automatic**: Don't manually check roles - backend enforces them
6. **Error messages**: Use error codes from response, not just error messages (they may be translated)
7. **Caching**: Dashboard data is expensive to compute; consider caching for 5-10 minutes
8. **Bulk operations**: For bulk payments, submit individually, not as array (supports better error handling)

---

## Support & Questions

For issues or questions:
1. Check [IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md) for API details
2. Check [DASHBOARD_TICKET_PAYMENT_STRATEGY.md](./DASHBOARD_TICKET_PAYMENT_STRATEGY.md) for business logic
3. Review error codes table above
4. Contact backend team with specific error code and request details

---

**Ready to integrate!** 🚀
