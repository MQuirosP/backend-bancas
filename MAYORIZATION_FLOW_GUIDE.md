# Mayorization Flow - Complete Guide

## Problem Identified

Frontend was receiving empty data: `mayorizations: 0` instead of an array.

**Root Cause**: The endpoint was returning the correct structure but with the wrong field name:
- **Was returning**: `{ success: true, data: [], pagination: {...}, summary: {...} }`
- **Frontend expects**: `{ success: true, mayorizations: [], pagination: {...}, summary: {...} }`

**Fixed**: Changed controller to return `mayorizations` field instead of `data`.

---

## Three-Step Flow Required

### Step 1: Calculate Mayorization (Creates Record)
```bash
POST /api/v1/accounts/{accountId}/mayorizations/calculate
Query Parameters:
  - fromDate=2025-11-01
  - toDate=2025-11-03

Response (201):
{
  "success": true,
  "data": {
    "id": "maj_550e8400...",
    "accountId": "...",
    "ownerType": "VENTANA",
    "ownerId": "...",
    "totalSales": 1500000.00,
    "totalPrizes": 1200000.00,
    "totalCommission": 45000.00,
    "netOperative": 255000.00,
    "debtStatus": "CXC",
    "status": "OPEN",
    "isSettled": false
  }
}
```

**What it does**:
- Aggregates all tickets (jugadas) in the period
- Calculates totalSales, totalPrizes, totalCommission
- Creates a `MayorizationRecord` entry in the database
- Returns the record with a unique `id` (needed for settlement)

---

### Step 2: Get Mayorization History (Reads Records)
```bash
GET /api/v1/accounts/mayorizations/history
Query Parameters (all optional):
  - period=week (default) | today | yesterday | month | year | range
  - fromDate=2025-11-01
  - toDate=2025-11-03
  - ownerType=VENTANA
  - ownerId={uuid}
  - debtStatus=CXC | CXP | BALANCE
  - isSettled=true | false
  - page=1 (default)
  - pageSize=20 (default)
  - orderBy=date | debtAmount | netOperative
  - order=asc | desc (default)

Response (200):
{
  "success": true,
  "mayorizations": [
    {
      "id": "maj_550e8400...",
      "ownerId": "user_550e8400...",
      "ownerName": "Ventana San José",
      "ownerType": "VENTANA",
      "date": "2025-11-03",
      "totalSales": 1500000.00,
      "totalPrizes": 1200000.00,
      "totalCommission": 45000.00,
      "netOperative": 255000.00,
      "debtStatus": "CXC",
      "debtAmount": 255000.00,
      "status": "OPEN",
      "isSettled": false
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "total": 1,
    "totalPages": 1
  },
  "summary": {
    "totalDebtAmount": 255000.00,
    "totalSettledAmount": 0,
    "pendingSettlement": 255000.00
  }
}
```

**What it does**:
- Reads persisted `MayorizationRecord` entries from database
- Filters by period and optional criteria
- Returns array of records with their `id` fields
- Provides pagination and summary totals

**KEY POINT**: This endpoint returns persisted records, not in-memory calculations. Must call Step 1 first to create records.

---

### Step 3: Settle Majorization (Records Settlement)
```bash
POST /api/v1/accounts/mayorizations/settle
Request Body:
{
  "mayorizationId": "maj_550e8400...",  ← Use 'id' from Step 2
  "amount": 255000.00,
  "settlementType": "PAYMENT",          ← or "COLLECTION"
  "date": "2025-11-03",
  "reference": "CHK-004567",            ← Check number, receipt ID, etc
  "note": "Payment via check",
  "requestId": "req_123456"             ← Optional: prevents duplicate settlements
}

Response (201):
{
  "success": true,
  "data": {
    "mayorization": {
      "id": "maj_550e8400...",
      "status": "SETTLED",
      "isSettled": true,
      "settledDate": "2025-11-03",
      "settledAmount": 255000.00,
      "settlementType": "PAYMENT",
      "settlementRef": "CHK-004567"
    },
    "ledgerEntry": {
      "id": "entry_550e8400...",
      "type": "ADJUSTMENT",
      "valueSigned": -255000.00,
      "note": "PAYMENT - Ref: CHK-004567 (Payment via check)"
    },
    "newBalance": 1500000.00
  }
}
```

**What it does**:
- Validates that the majorization is OPEN (not already settled)
- Creates a ledger entry (journal entry) for the settlement
- Updates the majorization record to SETTLED status
- Automatically updates account balance
- Returns the updated majorization and ledger entry

---

## State Diagram

```
Step 1: Calculate
┌─────────────────────────┐
│ POST /calculate         │
│ Creates MayorizationRec │
│ status = OPEN           │
│ Returns: id             │
└────────────┬────────────┘
             │
             ↓ (id from response)
┌─────────────────────────┐
│ GET /history            │
│ Reads from DB           │
│ Returns: array with id  │
└────────────┬────────────┘
             │
             ↓ (select one from array)
Step 3: Settle
┌─────────────────────────┐
│ POST /settle            │
│ Pass id from step 2     │
│ status = OPEN → SETTLED │
│ Creates ledger entry    │
└─────────────────────────┘
```

---

## Important Notes

1. **Data Flow**: `POST /calculate` → `GET /history` → `POST /settle`
   - Must create record before retrieving it
   - Must retrieve record before settling it

2. **Field Naming**: The response field is `mayorizations` (array), not `data`
   - `mayorizations: []` (plural array)
   - Each item has `id` field used in settlement

3. **Status Immutability**: Once `isSettled: true`, cannot be changed
   - Attempting to settle twice returns `409 CONFLICT`
   - Reason: `"Majorization is already settled"`

4. **Ledger Entry Creation**: Settlement automatically creates a journal entry
   - Type: `ADJUSTMENT`
   - Signed amount: negative for PAYMENT, positive for COLLECTION
   - Automatically updates account balance

5. **RBAC Filtering**:
   - ADMIN: sees all records
   - VENTANA: sees only their own records (auto-filtered)
   - VENDEDOR: sees only their own records (auto-filtered)

6. **Idempotency**: Include `requestId` to prevent duplicate settlements
   - If same request is retried, returns existing settlement (201)
   - Prevents accidental double-processing

7. **No Test Data**: Database is empty for mayorizations
   - Create tickets first (via other endpoints)
   - Then call `POST /calculate` to generate records
   - Then `GET /history` will return data

---

## Frontend Integration Checklist

- [ ] Call `POST /calculate` with accountId, fromDate, toDate → get `id`
- [ ] Call `GET /history` → get array of mayorizations with `id` fields
- [ ] Display mayorizations in UI
- [ ] User selects one to settle
- [ ] Call `POST /settle` with `mayorizationId` from selected item
- [ ] Verify response `isSettled: true`
- [ ] Call `GET /history` again to refresh UI
- [ ] Verify settled item now has `status: "SETTLED"` and `settledDate` populated
- [ ] Handle errors:
  - 400: Validation error (check parameters)
  - 404: Majorization not found (invalid id)
  - 409: Already settled (cannot settle twice)
  - 500: Server error (check logs)

---

## Common Errors & Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `mayorizations: 0` (empty) | No records in DB | Call `POST /calculate` first |
| 404 on settle | Invalid mayorizationId | Use `id` from `GET /history` response |
| 409 Conflict | Already settled | Check `isSettled: true` before settling |
| 400 Validation | Bad parameters | Check date format (YYYY-MM-DD), types |
| Field undefined | Accessing wrong field | Use `mayorizations` (plural), not `data` |

---

## Architecture Decision: Record-First

The system uses a **record-first** approach:
- Calculations are persisted immediately (not in-memory)
- Each calculation creates a unique `MayorizationRecord` entry
- History is read from database (consistent, auditable)
- Settlements reference the record by `id`

Benefits:
- Audit trail: all calculations stored with timestamps
- Consistency: history doesn't recalculate on every view
- Traceability: can see exactly which records were settled and when
- No data loss: if settlement fails, calculation is preserved

---

## Testing the Flow

```bash
# 1. Calculate
curl -X POST "http://localhost:3000/api/v1/accounts/{accountId}/mayorizations/calculate?fromDate=2025-11-01&toDate=2025-11-03" \
  -H "Authorization: Bearer <token>"

# Copy the returned "id" value

# 2. Get history
curl "http://localhost:3000/api/v1/accounts/mayorizations/history?period=week" \
  -H "Authorization: Bearer <token>"

# Should see the record with the id from step 1

# 3. Settle
curl -X POST "http://localhost:3000/api/v1/accounts/mayorizations/settle" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "mayorizationId": "maj_550e8400...",
    "amount": 255000,
    "settlementType": "PAYMENT",
    "date": "2025-11-03",
    "reference": "CHK-001"
  }'

# Should return 201 with isSettled: true
```

---

## Additional Resources

- Full API Reference: See `ENDPOINTS_MAJORIZATION_SUMMARY.md`
- Database Schema: See Prisma schema `model MayorizationRecord`
- Service Logic: See `src/api/v1/services/accounts.service.ts` methods:
  - `calculateMayorization()`
  - `getMayorizationHistory()`
  - `settleMayorization()`
