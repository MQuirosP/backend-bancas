# MAYORIZATION - Frontend Implementation Guide

## What the FE Receives (Complete Data for Decision Making)

### 1. When calculating majorization (POST /mayorizations/calculate)

The FE gets **ALL the data needed to determine payments/collections**:

```json
{
  "success": true,
  "data": {
    "id": "maj_550e8400...",

    // OWNER IDENTIFICATION
    "ownerCode": "VEN-001",        // ← Ventana/Vendedor code (NOT ID!)
    "ownerName": "Ventana San José", // ← Real name
    "ownerType": "VENTANA",         // ← Type
    "ownerId": "user_uuid",         // ← ID (for backend queries)

    // FINANCIAL METRICS (What actually happened in the period)
    "totalSales": 5000000.00,       // ← Total ticket amounts
    "totalPrizes": 4000000.00,      // ← Total paid out
    "totalCommission": 150000.00,   // ← Commission earned (informational)

    // NET CALCULATION (what they owe or we owe them)
    "netOperative": 1150000.00,     // ← Net: sales - prizes
    "debtStatus": "CXC",            // ← Status: CXC=we owe, CXP=they owe, BALANCE=even
    "debtAmount": 1150000.00,       // ← ★ AMOUNT TO PAY/COLLECT ★
    "debtDescription": "Le debemos ₡1,150,000 al listero", // ← User-friendly text

    // PERIOD INFO
    "fromDate": "2025-11-01",
    "toDate": "2025-11-03",

    // STATUS
    "status": "OPEN",               // ← Ready to settle
    "isSettled": false,
    "createdAt": "2025-11-03T17:00:00Z"
  }
}
```

### 2. When retrieving history (GET /mayorizations/history)

The FE gets **array of records with pagination + summary**:

```json
{
  "success": true,

  "mayorizations": [
    {
      "id": "maj_550e8400...",      // ← Use THIS for settle request

      // OWNER INFO
      "ownerCode": "VEN-001",
      "ownerName": "Ventana San José",
      "ownerType": "VENTANA",
      "ownerId": "user_uuid",

      // FINANCIAL DATA
      "date": "2025-11-03",
      "totalSales": 5000000.00,
      "totalPrizes": 4000000.00,
      "totalCommission": 150000.00,
      "netOperative": 1150000.00,

      // WHAT TO DO
      "debtStatus": "CXC",           // Determines: PAY or COLLECT
      "debtAmount": 1150000.00,      // ★ AMOUNT ★

      // SETTLEMENT STATUS
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
    "pageSize": 20,
    "total": 5,
    "totalPages": 1
  },

  "summary": {
    "totalDebtAmount": 5750000.00,     // ← Total we owe (sum of CXC)
    "totalSettledAmount": 0,           // ← Already paid/collected
    "pendingSettlement": 5750000.00    // ← Still need to settle
  }
}
```

---

## What the FE Does with This Data

### Flow 1: Banca (can see all, can pay/collect from Ventana)

```javascript
// 1. SHOW SUMMARY DASHBOARD
Get /mayorizations/history?period=week
{
  totalDebtAmount: 5750000    // "Deudas pendientes: ₡5,750,000"
  totalSettledAmount: 0       // "Ya pagadas: ₡0"
  pendingSettlement: 5750000  // "Por cobrar: ₡5,750,000"
}

// 2. SHOW LIST OF VENTANAS WITH DEBT
mayorizations.forEach(record => {
  if (record.debtStatus === 'CXC') {
    // Display: "Ventana San José [VEN-001]: Deuda ₡1,150,000"
    // Buton: "Registrar Pago"
  } else if (record.debtStatus === 'CXP') {
    // Display: "Ventana San José [VEN-001]: Debemos ₡X"
    // Button: "Registrar Cobro" (we owe them)
  }
})

// 3. WHEN USER CLICKS "Registrar Pago"
POST /mayorizations/settle
{
  mayorizationId: "maj_550e8400...",  // ← From record.id
  amount: 1150000.00,                 // ← From record.debtAmount
  settlementType: "PAYMENT",          // ← For CXC
  date: "2025-11-03",
  reference: "CHK-001234",
  note: "Check payment"
}
```

### Flow 2: Ventana (can see own + their vendedores, can pay vendedores)

```javascript
// 1. FILTER BY OWN VENTANA (auto-filtered by RBAC)
Get /mayorizations/history  // No filter needed, BE returns only mine

// 2. SHOW OWN DEBT
if (mayorizations[0].debtStatus === 'CXC') {
  // "You owe Bank ₡1,150,000"
  // Can pay directly with settle endpoint
} else if (mayorizations[0].debtStatus === 'CXP') {
  // "Bank owes you ₡X"
}

// 3. SHOW VENDEDORES WITH DEBT (if Ventana owns vendedores)
Get /mayorizations/history?ownerType=VENDEDOR
mayorizations.forEach(vendedor => {
  // "Vendedor Carlos [VEN-C-001]: Deuda ₡150,000"
  // Ventana can settle with them too
})

// 4. SETTLE VENDEDOR PAYMENT
POST /mayorizations/settle
{
  mayorizationId: "maj_...",
  amount: 150000.00,         // Amount vendedor owes
  settlementType: "PAYMENT",
  date: "2025-11-03",
  reference: "VEN-PAYMENT-001"
}
```

### Flow 3: Vendedor (read-only, can only see own)

```javascript
// 1. VIEW OWN MAYORIZATION (auto-filtered)
Get /mayorizations/history  // Only shows their own

// 2. DISPLAY
"Your financial summary for 2025-11-01 to 2025-11-03:"
"Sales: ₡5,000,000"
"Prizes Paid: ₡4,000,000"
"Commission: ₡150,000"
"Balance: ₡1,150,000"
"Status: Ready for settlement"

// 3. CAN VIEW BUT NOT SETTLE
// No button, just informational display
```

---

## Key Information for FE Implementation

### What FE Needs to Know

1. **debtAmount is the answer to "how much?"**
   - If `debtStatus: "CXC"` → Pay this amount to bank/Ventana
   - If `debtStatus: "CXP"` → Collect this amount from bank/Ventana
   - If `debtStatus: "BALANCE"` → No payment needed

2. **ownerCode is for display**
   - NOT the UUID, the actual code (e.g., "VEN-001")
   - Shows alongside ownerName for user clarity

3. **Hierarchy for settlements**
   - **Banca** settles with **Ventana** using debtAmount (CXC/CXP)
   - **Ventana** settles with **Vendedor** using debtAmount (CXC/CXP)
   - **Vendedor** cannot settle (read-only)

4. **totalCommission is informational only**
   - Shows how much commission was earned
   - Used for transparency, not for payment calculation
   - Payment is based on `debtAmount` only

5. **Status flow**
   - OPEN → Unsettled, can be settled
   - SETTLED → Done, cannot change
   - Cannot settle the same record twice (409 error)

### Error Handling

```javascript
POST /mayorizations/settle
// 404: mayorizationId not found
// 409: Already settled (isSettled=true)
// 400: Invalid amount/type/date
// 500: Server error (check logs)
```

### Date Handling

- All dates in Costa Rica timezone (GMT-6)
- Format: YYYY-MM-DD for requests
- Format: YYYY-MM-DD (string) for responses
- `toDate` in response = period end date (use for UI display)

---

## Database Perspective (What Happens Behind Scenes)

### Calculate (POST)
1. FE sends: accountId, fromDate, toDate
2. BE aggregates: SUM(ticket.totalAmount) = totalSales
3. BE aggregates: SUM(jugada.payout WHERE isWinner) = totalPrizes
4. BE aggregates: SUM(jugada.commissionAmount) = totalCommission
5. BE calculates: netOperative = totalSales - totalPrizes
6. BE determines: debtStatus based on netOperative sign
7. BE saves to **MayorizationRecord** table
8. BE returns record with `id` (use for settlement)

### History (GET)
1. FE sends: filters (period, owner type, etc.)
2. BE queries: **MayorizationRecord** table (persisted data)
3. BE fetches: owner codes from **Ventana** or **User** tables
4. BE returns: array + pagination + summary

### Settle (POST)
1. FE sends: mayorizationId + amount + type
2. BE validates: isSettled = false
3. BE creates: **LedgerEntry** with signed amount
4. BE updates: **MayorizationRecord** to isSettled = true
5. BE updates: **Account** balance
6. BE returns: updated record

---

## Response Format Standard

All endpoints follow:
```json
{
  "success": true,
  "data": { /* endpoint-specific */ },
  "meta": { /* optional pagination/summary */ }
}

// Or for errors:
{
  "success": false,
  "error": {
    "message": "...",
    "code": "..."
  }
}
```

---

## Testing Checklist for FE

- [ ] Calculate majorization returns `id` field
- [ ] Get history returns array with pagination
- [ ] debtAmount matches: totalSales - totalPrizes
- [ ] ownerCode populated (not null)
- [ ] Settle with correct mayorizationId succeeds (201)
- [ ] Settle same record twice returns 409 error
- [ ] Summary totals match filtered data
- [ ] RBAC filtering: Ventana only sees own, Vendedor only sees own
- [ ] Can filter by period, debtStatus, isSettled
- [ ] Pagination works (page, pageSize parameters)
- [ ] Sorting works (orderBy, order parameters)

---

## Quick Reference: What Fields to Show in UI

### List View (GET /mayorizations/history)
```
[VEN-001] Ventana San José
  Sales: ₡5,000,000
  Debt: ₡1,150,000 (CXC - We owe)
  Status: OPEN
  [Pay]  [Details]
```

### Detail View
```
Ventana San José (VEN-001)
Period: 2025-11-01 to 2025-11-03

Financial Summary:
  Total Sales:      ₡5,000,000
  Prizes Paid:      ₡4,000,000
  Commission:       ₡150,000 (informational)
  Net Balance:      ₡1,150,000

Settlement:
  Status:           OPEN
  Amount Due:       ₡1,150,000
  Type:             PAYMENT (we owe)

  [Register Payment]
```

### Settlement Dialog
```
Settlement for Ventana San José (VEN-001)
Amount: ₡1,150,000
Type: PAYMENT
Date: 2025-11-03
Reference: [User enters check number/receipt ID]
Note: [Optional]

[Cancel] [Confirm]
```

After confirmation:
```
✓ Settlement recorded
  Amount: ₡1,150,000
  Reference: CHK-001234
  Date: 2025-11-03
  Status: SETTLED
```

---

## API Ready Status

✅ All endpoints tested and documented
✅ All financial metrics included
✅ Owner codes and names fetched
✅ RBAC enforcement working
✅ Error handling standardized
✅ Response format consistent
✅ Pagination implemented
✅ Summary totals calculated

**Backend is ready for frontend integration.**
