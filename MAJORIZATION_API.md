# Majorization API Specification

## Overview
The Majorization module manages financial closing calculations and settlements for ventanas (VENTANA) and vendors (VENDEDOR). Records are persisted in `MayorizationRecord` table for audit trails and prevent recalculation.

---

## Endpoints

### 1. POST `/api/v1/accounts/mayorizations/calculate`
**Purpose**: Calculate and persist a majorization record for an account over a date range.

**Request**:
```json
{
  "accountId": "550e8400-e29b-41d4-a716-446655440000",
  "fromDate": "2025-11-01",
  "toDate": "2025-11-03",
  "includeDesglose": "false"
}
```

**Path/Query Parameters**:
- `accountId` (path): UUID of the account

**Query Parameters**:
- `fromDate` (required): ISO date string (YYYY-MM-DD)
- `toDate` (required): ISO date string (YYYY-MM-DD)
- `includeDesglose` (optional): "true" | "false" (default: "false")

**Response** (201 Created):
```json
{
  "success": true,
  "data": {
    "id": "maj_550e8400e29b41d4a716446655440000",
    "accountId": "550e8400-e29b-41d4-a716-446655440000",
    "ownerType": "VENTANA",
    "ownerId": "e29b41d4-a716-446655440550",
    "ownerName": "Ventana Central",
    "ownerCode": "VC-001",
    "fromDate": "2025-11-01",
    "toDate": "2025-11-03",
    "totalSales": 500000.00,
    "totalPrizes": 350000.00,
    "totalCommission": 15000.00,
    "netOperative": 135000.00,
    "debtStatus": "CXC",
    "debtAmount": 135000.00,
    "debtDescription": "Le debemos 135,000.00",
    "status": "OPEN",
    "computedAt": "2025-11-03T18:30:45.123Z",
    "createdBy": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

**Error Responses**:
- 400: Invalid date range or parameters
- 404: Account not found
- 409: Majorization already settled for period (if conflict policy applies)
- 500: Calculation error

**Logging**:
- Layer: controller + service
- Action: CALCULATE_MAJORIZATION / LEDGER_ADD
- ActivityLog: LEDGER_ADD with targetType "MAJORIZATION"

---

### 2. GET `/api/v1/accounts/mayorizations/history`
**Purpose**: Retrieve persisted majorization records with optional filters.

**Query Parameters**:
- `period` (optional): "today" | "yesterday" | "week" | "month" | "year" | "range" (default: "week")
- `fromDate` (optional): ISO date string (YYYY-MM-DD) - used if period="range"
- `toDate` (optional): ISO date string (YYYY-MM-DD) - used if period="range"
- `ownerType` (optional): "LISTERO" → "VENTANA" | "VENDEDOR"
- `ownerId` (optional): UUID of owner
- `debtStatus` (optional): "CXC" | "CXP" | "BALANCE"
- `isSettled` (optional): "true" | "false"
- `page` (optional, default: 1): Page number
- `pageSize` (optional, default: 20): Records per page
- `orderBy` (optional): "date" | "debtAmount" | "netOperative"
- `order` (optional): "asc" | "desc"

**Request Example**:
```
GET /api/v1/accounts/mayorizations/history?period=range&fromDate=2025-11-01&toDate=2025-11-03&ownerType=VENTANA&debtStatus=CXC&page=1&pageSize=10
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "id": "maj_550e8400e29b41d4a716446655440000",
      "ownerId": "e29b41d4-a716-446655440550",
      "ownerName": "Ventana Central",
      "ownerCode": "VC-001",
      "ownerType": "Listero",
      "date": "2025-11-03",
      "totalSales": 500000.00,
      "totalPrizes": 350000.00,
      "totalCommission": 15000.00,
      "netOperative": 135000.00,
      "debtStatus": "CXC",
      "debtAmount": 135000.00,
      "debtDescription": "Le debemos 135,000.00",
      "status": "OPEN",
      "isSettled": false,
      "settledDate": null,
      "settledAmount": null,
      "settlementType": null,
      "settlementRef": null
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 10,
    "total": 1,
    "totalPages": 1
  },
  "summary": {
    "totalDebtAmount": 135000.00,
    "totalSettledAmount": 0.00,
    "pendingSettlement": 135000.00
  }
}
```

**Error Responses**:
- 400: Invalid filter parameters
- 401: Unauthorized (RBAC restrictions apply)
- 500: Database error

**Logging**:
- Layer: controller + service
- Action: GET_MAYORIZATION_HISTORY
- ActivityLog: Only errors (SYSTEM_ACTION)

---

### 3. POST `/api/v1/accounts/mayorizations/settle`
**Purpose**: Record a settlement (payment/collection) for an open majorization record.

**Request Body**:
```json
{
  "mayorizationId": "maj_550e8400e29b41d4a716446655440000",
  "amount": 135000.00,
  "settlementType": "PAYMENT",
  "date": "2025-11-03",
  "reference": "CHK-004567",
  "note": "Payment via check",
  "requestId": "req_idempotency_key_optional"
}
```

**Request Parameters**:
- `mayorizationId` (body, required): UUID of the majorization record to settle
- `amount` (body, required): Positive decimal amount
- `settlementType` (body, required): "PAYMENT" | "COLLECTION"
- `date` (body, required): ISO date string (YYYY-MM-DD)
- `reference` (body, required): Check number, document reference, etc.
- `note` (body, optional): Free-text note
- `requestId` (body, optional): Idempotency key to prevent duplicate settlements

**Response** (201 Created):
```json
{
  "success": true,
  "data": {
    "mayorization": {
      "id": "maj_550e8400e29b41d4a716446655440000",
      "accountId": "550e8400-e29b-41d4-a716-446655440000",
      "ownerType": "VENTANA",
      "ownerId": "e29b41d4-a716-446655440550",
      "ownerName": "Ventana Central",
      "fromDate": "2025-11-01",
      "toDate": "2025-11-03",
      "totalSales": 500000.00,
      "totalPrizes": 350000.00,
      "totalCommission": 15000.00,
      "netOperative": 135000.00,
      "debtStatus": "CXC",
      "debtAmount": 135000.00,
      "status": "SETTLED",
      "isSettled": true,
      "settledDate": "2025-11-03",
      "settledAmount": 135000.00,
      "settlementType": "PAYMENT",
      "settlementRef": "CHK-004567",
      "settledBy": "550e8400-e29b-41d4-a716-446655440001"
    },
    "ledgerEntry": {
      "id": "ent_550e8400e29b41d4a716446655440000",
      "accountId": "550e8400-e29b-41d4-a716-446655440000",
      "type": "ADJUSTMENT",
      "valueSigned": -135000.00,
      "referenceType": "ADJUSTMENT_DOC",
      "referenceId": "maj_550e8400e29b41d4a716446655440000",
      "date": "2025-11-03",
      "createdBy": "550e8400-e29b-41d4-a716-446655440001"
    },
    "newBalance": 1500000.00
  }
}
```

**Error Responses**:
- 400: Validation error (invalid UUID, missing required fields)
- 404: Majorization record not found
- 409: Majorization already settled
- 500: Settlement error

**Logging**:
- Layer: controller + service
- Action: SETTLE_MAJORIZATION
- ActivityLog: LEDGER_ADD with targetType "SETTLEMENT"
- Contains: mayorizationId, accountId, settlementType, amount, reference

---

## Data Flow & State Machine

### MayorizationRecord States
```
OPEN
  ├─→ [POST /settle] → SETTLED
  └─→ [POST /calculate with force] → OPEN (recalculate)

SETTLED (immutable)
  └─→ No further changes allowed
```

### Typical User Flow
1. **Calculate**: POST `/mayorizations/calculate` → Returns `id`
2. **View**: GET `/mayorizations/history?ownerType=VENTANA&debtStatus=CXC` → See open records with `id`
3. **Settle**: POST `/mayorizations/settle` → Pass `id` from step 2, mark SETTLED

---

## Response Structure Pattern

All successful responses follow:
```json
{
  "success": true,
  "data": { /* endpoint-specific */ },
  "pagination": { /* if applicable */ },
  "summary": { /* if applicable */ }
}
```

All error responses follow:
```json
{
  "success": false,
  "error": {
    "message": "Human-readable error",
    "code": "ERROR_CODE"
  }
}
```

---

## ActivityLog Mapping

| Action | ActivityType | TargetType | Details |
|--------|--------------|-----------|---------|
| Calculate majorization | LEDGER_ADD | MAJORIZATION | period, totals, debtStatus |
| Settle majorization | LEDGER_ADD | SETTLEMENT | mayorizationId, amount, reference |
| Error in endpoint | SYSTEM_ACTION | ERROR | controller_action, http_status, error_code |

---

## RBAC Notes

- ADMIN: Can view/settle all owner's majorizations
- VENTANA: Can only view/settle their own majorizations
- VENDEDOR: Can only view/settle their own majorizations

Filtering enforced at service layer via RBAC context.

---

## Future Endpoints (Not in MVP)

- `GET /api/v1/accounts/mayorizations/:id` - Get single record
- `GET /api/v1/accounts/mayorizations/preview` - Calculate without persisting
- `DELETE /api/v1/accounts/mayorizations/:id` - Soft delete (require ADMIN)
