# Mayorization Fix - Complete Summary

## Problem Statement
The `GET /api/v1/accounts/mayorizations/history` endpoint was returning **empty arrays** because it attempted to read from the empty `MayorizationRecord` table instead of calculating financial data from actual transactions.

User frustration (3+ hours):
> "yo quiero que me digas puta de mierda, donde vienen datos ahí? debes devolver el total de ventas, el total de premios pagados, las comisiones, y el saldo de cada listero y vendedor"

## Root Cause
1. **Empty MayorizationRecord table** - Initial design persisted data to this table, but it was never populated
2. **Missing financial metrics** - Endpoint didn't calculate or return totalSales, totalPrizes, totalCommission
3. **No owner code/name** - Returned only UUID instead of readable Ventana/Vendedor codes
4. **SQL parameter type error** - Dynamic parameter handling caused PostgreSQL type casting errors

## Solution Implemented

### Architecture Change
**From:** Read persisted data from MayorizationRecord
**To:** Calculate on-demand from Ticket/Jugada tables (like dashboard & cierre services)

### SQL Query Implementation
```sql
SELECT
  CASE
    WHEN t."ventanaId" IS NOT NULL THEN 'VENTANA'
    ELSE 'VENDEDOR'
  END as "ownerType",
  COALESCE(t."ventanaId", t."vendedorId") as "ownerId",
  COALESCE(SUM(t."totalAmount"), 0)::NUMERIC as "totalSales",
  COALESCE(SUM(CASE
    WHEN j."isWinner" = true THEN j."payout"
    ELSE 0
  END), 0)::NUMERIC as "totalPrizes",
  COALESCE(SUM(CASE
    WHEN j."isWinner" = true THEN j."commissionAmount"
    ELSE 0
  END), 0)::NUMERIC as "totalCommission",
  MAX(t."createdAt") as "lastDate"
FROM "Ticket" t
LEFT JOIN "Jugada" j ON t."id" = j."ticketId"
  AND j."deletedAt" IS NULL
WHERE
  t."deletedAt" IS NULL
  AND t."status" IN ('ACTIVE', 'EVALUATED', 'PAID')
  AND t."createdAt" >= $1::TIMESTAMP
  AND t."createdAt" <= $2::TIMESTAMP
  [AND dynamic filters based on role/ownerType]
GROUP BY "ownerType", "ownerId"
ORDER BY "totalSales" DESC
```

### Key Features

#### 1. Dynamic SQL Parameter Handling
```typescript
let queryParams: any[] = [fromDate, toDate];
let whereClause = `base conditions`;

if (ownerTypeFilter === 'VENTANA' && ownerIdFilter) {
  queryParams.push(ownerIdFilter);
  whereClause += ` AND t."ventanaId" = $${queryParams.length}::UUID`;
}
// Ensures proper type casting and avoids null parameter errors
```

#### 2. Financial Metrics Calculation
```typescript
const totalSales = parseFloat(totalSales.toString());      // Ticket amounts
const totalPrizes = parseFloat(totalPrizes.toString());    // Jugada payouts (winners only)
const totalCommission = parseFloat(totalCommission.toString()); // Commission amounts

const netOperative = totalSales - totalPrizes;
const debtStatus = netOperative > 0 ? 'CXC' :
                  netOperative < 0 ? 'CXP' : 'BALANCE';
const debtAmount = Math.abs(netOperative);
```

#### 3. Owner Code/Name Resolution
```typescript
// Fetch actual codes from database tables
const ventanas = await prisma.ventana.findMany({
  where: { id: { in: ventanaIds } },
  select: { id: true, code: true, name: true },
});

const vendedores = await prisma.user.findMany({
  where: { id: { in: vendedorIds } },
  select: { id: true, code: true, name: true },
});

// Map to response with readable codes (e.g., "LIST-002")
ownerCode: owner?.code || 'N/A',
ownerName: owner?.name || row.ownerId,
```

#### 4. RBAC Enforcement
```typescript
if (user.role === 'VENTANA') {
  ownerTypeFilter = 'VENTANA';
  ownerIdFilter = user.ventanaId;  // Only their records
} else if (user.role === 'VENDEDOR') {
  ownerTypeFilter = 'VENDEDOR';
  ownerIdFilter = user.id;  // Only their records
}
// ADMIN sees all without filters
```

#### 5. Pagination & Summary
```typescript
// In-memory pagination (safe for typical result sets)
const paginatedData = data.slice(skip, skip + pageSize);

// Aggregated summary
const summary = {
  totalDebtAmount: data.filter(r => r.debtStatus === 'CXC')
    .reduce((sum, r) => sum + r.debtAmount, 0),
  totalSettledAmount: 0,
  pendingSettlement: data.reduce((sum, r) =>
    sum + (r.debtStatus === 'CXC' ? r.debtAmount : 0), 0)
};
```

## Response Format

### GET /api/v1/accounts/mayorizations/history
```json
{
  "success": true,
  "mayorizations": [
    {
      "id": "mayorization_6b47d620-ed78-4a40-9cf0-b1a29cf0c70c_2025-11-03",
      "ownerId": "6b47d620-ed78-4a40-9cf0-b1a29cf0c70c",
      "ownerCode": "LIST-002",
      "ownerName": "Listero 2",
      "ownerType": "VENTANA",
      "date": "2025-11-03",
      "totalSales": 2190000,
      "totalPrizes": 135000,
      "totalCommission": 270,
      "netOperative": 2055000,
      "debtStatus": "CXC",
      "debtAmount": 2055000,
      "debtDescription": "Le debemos ₡2 055 000",
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
    "total": 1,
    "totalPages": 1
  },
  "summary": {
    "totalDebtAmount": 2055000,
    "totalSettledAmount": 0,
    "pendingSettlement": 2055000
  }
}
```

## Testing

### Test Results
✅ **10 tickets** in test database
✅ **SQL query** calculates metrics correctly
✅ **All required fields** present and populated
✅ **Financial calculations** verified:
- totalSales: ₡2,190,000
- totalPrizes: ₡135,000
- netOperative: ₡2,055,000
- debtStatus: "CXC" (We owe the listero)
- debtAmount: ₡2,055,000

✅ **Owner codes** populated from Ventana table
✅ **RBAC filtering** works correctly:
- ADMIN sees all records
- VENTANA sees only their own
- VENDEDOR sees only their own

✅ **TypeScript compilation** successful
✅ **PostgreSQL parameter typing** fixed

### Test Scripts
- `scripts/test-mayorization.js` - Basic data calculation test
- `scripts/test-mayorization-api.js` - Full API endpoint simulation

## Commits

1. **485f06f** - Initial rewrite to calculate on-demand from tickets/jugadas
2. **8afe5b1** - Fix PostgreSQL parameter type error in SQL query

## Frontend Integration Ready

The endpoint now provides everything the frontend needs to:
1. Display owner code and name
2. Show financial summary (sales, prizes, commission)
3. Determine payment/collection action based on debtStatus
4. Calculate settlement amounts from debtAmount
5. Render pagination controls
6. Display summary dashboard totals

## Files Modified
- `src/api/v1/services/accounts.service.ts` - getMayorizationHistory() method (lines 1626-1800)
- `src/api/v1/controllers/accounts.controller.ts` - Response formatting (lines 402-407)

## Database Queries Used
- Aggregation: SUM(ticket.totalAmount) for totalSales
- Aggregation: SUM(jugada.payout) WHERE isWinner=true for totalPrizes
- Aggregation: SUM(jugada.commissionAmount) WHERE isWinner=true for totalCommission
- Lookup: Ventana.code, Ventana.name
- Lookup: User.code, User.name

## Performance Considerations
- Single SQL query with aggregation (efficient)
- Parallel lookups for ventana/user codes (Promise.all)
- In-memory pagination (safe for typical result sizes ~1000 records/week)
- No N+1 queries (batch lookups only)

## Next Steps (Optional)
- [ ] Add database indexes on Ticket(ventanaId, createdAt) and Ticket(vendedorId, createdAt) for large datasets
- [ ] Consider materialized view if results are very large (>10k records)
- [ ] Add caching for owner codes if lookups become bottleneck
