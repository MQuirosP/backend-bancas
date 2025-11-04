# ACCOUNTS MODULE - COMPLETE ENDPOINT SPECIFICATION

**Standard Response Format**:
```json
{
  "success": true,
  "data": { /* endpoint-specific data */ },
  "meta": { /* optional metadata */ }
}
```

---

## 1. LIST ACCOUNTS
**Endpoint**: `GET /api/v1/accounts`
**Auth**: Required (all roles)

### Request
```
GET /api/v1/accounts?ownerType=VENTANA&ownerId=...&isActive=true&page=1&pageSize=20
```

**Query Parameters**:
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `ownerType` | string | No | BANCA \| LISTERO \| VENDEDOR |
| `ownerId` | string | No | Filter by owner ID |
| `isActive` | boolean | No | Filter active/inactive |
| `page` | number | No | Default: 1 |
| `pageSize` | number | No | Default: 20 |

### Response (200)
```json
{
  "success": true,
  "data": [
    {
      "id": "acc_uuid",
      "ownerType": "VENTANA",
      "ownerId": "user_uuid",
      "balance": 1500000.00,
      "currency": "CRC",
      "isActive": true,
      "createdAt": "2025-11-01T10:00:00Z",
      "updatedAt": "2025-11-03T14:00:00Z"
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 20,
    "total": 5,
    "totalPages": 1
  }
}
```

---

## 2. CREATE ACCOUNT
**Endpoint**: `POST /api/v1/accounts`
**Auth**: Required (ADMIN only)

### Request
```json
POST /api/v1/accounts
{
  "ownerType": "VENTANA",
  "ownerId": "user_uuid",
  "currency": "CRC",
  "initialBalance": 0,
  "initialBalanceNote": "Starting balance"
}
```

**Body Parameters**:
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `ownerType` | string | Yes | BANCA \| LISTERO(→VENTANA) \| VENDEDOR |
| `ownerId` | string | Yes | UUID of owner |
| `currency` | string | No | Default: CRC |
| `initialBalance` | number | No | Default: 0 |
| `initialBalanceNote` | string | No | Notes about initial balance |

### Response (201)
```json
{
  "success": true,
  "data": {
    "id": "acc_uuid",
    "ownerType": "VENTANA",
    "ownerId": "user_uuid",
    "balance": 0,
    "currency": "CRC",
    "isActive": true,
    "createdAt": "2025-11-03T14:30:00Z",
    "createdBy": "admin_uuid"
  }
}
```

**Error Responses**:
- `400`: Owner already has account
- `404`: Owner not found
- `500`: Database error

---

## 3. GET ACCOUNT DETAILS
**Endpoint**: `GET /api/v1/accounts/{accountId}`
**Auth**: Required (all roles)

### Request
```
GET /api/v1/accounts/acc_uuid
```

### Response (200)
```json
{
  "success": true,
  "data": {
    "id": "acc_uuid",
    "ownerType": "VENTANA",
    "ownerId": "user_uuid",
    "ownerName": "Ventana San José",
    "balance": 1500000.00,
    "currency": "CRC",
    "isActive": true,
    "createdAt": "2025-11-01T10:00:00Z",
    "updatedAt": "2025-11-03T14:00:00Z",
    "lastActivity": "2025-11-03T14:00:00Z"
  }
}
```

**Error Responses**:
- `404`: Account not found

---

## 4. GET ACCOUNT BALANCE
**Endpoint**: `GET /api/v1/accounts/{accountId}/balance`
**Auth**: Required (all roles)

### Request
```
GET /api/v1/accounts/acc_uuid/balance
```

### Response (200)
```json
{
  "success": true,
  "data": {
    "accountId": "acc_uuid",
    "balance": 1500000.00,
    "currency": "CRC",
    "lastUpdated": "2025-11-03T14:00:00Z"
  }
}
```

---

## 5. UPDATE ACCOUNT
**Endpoint**: `PUT /api/v1/accounts/{accountId}`
**Auth**: Required (ADMIN only)

### Request
```json
PUT /api/v1/accounts/acc_uuid
{
  "isActive": false
}
```

### Response (200)
```json
{
  "success": true,
  "data": {
    "id": "acc_uuid",
    "ownerType": "VENTANA",
    "ownerId": "user_uuid",
    "balance": 1500000.00,
    "isActive": false,
    "updatedAt": "2025-11-03T15:00:00Z"
  }
}
```

---

## 6. LIST LEDGER ENTRIES
**Endpoint**: `GET /api/v1/accounts/{accountId}/entries`
**Auth**: Required (all roles)

### Request
```
GET /api/v1/accounts/acc_uuid/entries?type=SALE,COMMISSION&from=2025-11-01&to=2025-11-03&page=1&pageSize=50
```

**Query Parameters**:
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | No | Comma-separated: SALE,COMMISSION,PAYOUT,ADJUSTMENT |
| `from` | string | No | ISO date |
| `to` | string | No | ISO date |
| `referenceType` | string | No | Filter by reference type |
| `page` | number | No | Default: 1 |
| `pageSize` | number | No | Default: 20 |
| `sort` | string | No | date \| createdAt |
| `order` | string | No | asc \| desc (default) |

### Response (200)
```json
{
  "success": true,
  "data": [
    {
      "id": "entry_uuid",
      "accountId": "acc_uuid",
      "type": "SALE",
      "date": "2025-11-03",
      "valueSigned": 1500000.00,
      "note": "Sale from ticket TKT-001",
      "referenceType": "TICKET",
      "referenceId": "tkt_uuid",
      "createdAt": "2025-11-03T10:00:00Z",
      "createdBy": "user_uuid"
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 50,
    "total": 150,
    "totalPages": 3
  }
}
```

---

## 7. ADD SALE ENTRY
**Endpoint**: `POST /api/v1/accounts/{accountId}/entries/sale`
**Auth**: Required (all roles)

### Request
```json
POST /api/v1/accounts/acc_uuid/entries/sale
{
  "ticketId": "tkt_uuid",
  "amount": 1500000.00,
  "requestId": "req_20251103_001"
}
```

### Response (201)
```json
{
  "success": true,
  "data": {
    "id": "entry_uuid",
    "accountId": "acc_uuid",
    "type": "SALE",
    "date": "2025-11-03",
    "valueSigned": 1500000.00,
    "note": "Sale entry for ticket TKT-001",
    "referenceType": "TICKET",
    "referenceId": "tkt_uuid",
    "createdAt": "2025-11-03T14:30:00Z"
  }
}
```

**Errors**:
- `400`: Invalid ticket ID or amount
- `404`: Account or ticket not found

---

## 8. ADD COMMISSION ENTRY
**Endpoint**: `POST /api/v1/accounts/{accountId}/entries/commission`
**Auth**: Required (all roles)

### Request
```json
POST /api/v1/accounts/acc_uuid/entries/commission
{
  "saleAmount": 1500000.00,
  "commissionRate": 0.03,
  "ticketId": "tkt_uuid",
  "requestId": "req_20251103_002"
}
```

### Response (201)
```json
{
  "success": true,
  "data": {
    "id": "entry_uuid",
    "accountId": "acc_uuid",
    "type": "COMMISSION",
    "date": "2025-11-03",
    "valueSigned": 45000.00,
    "note": "Commission: 3% of ₡1,500,000",
    "referenceType": "TICKET",
    "referenceId": "tkt_uuid",
    "createdAt": "2025-11-03T14:30:00Z"
  }
}
```

---

## 9. ADD PAYOUT ENTRY
**Endpoint**: `POST /api/v1/accounts/{accountId}/entries/payout`
**Auth**: Required (all roles)

### Request
```json
POST /api/v1/accounts/acc_uuid/entries/payout
{
  "amount": 1200000.00,
  "payoutId": "payout_uuid",
  "reason": "Prize payout for winning numbers",
  "requestId": "req_20251103_003"
}
```

### Response (201)
```json
{
  "success": true,
  "data": {
    "id": "entry_uuid",
    "accountId": "acc_uuid",
    "type": "PAYOUT",
    "date": "2025-11-03",
    "valueSigned": -1200000.00,
    "note": "Prize payout: 1,200,000",
    "referenceType": "PAYOUT",
    "referenceId": "payout_uuid",
    "createdAt": "2025-11-03T14:30:00Z"
  }
}
```

---

## 10. REVERSE LEDGER ENTRY
**Endpoint**: `POST /api/v1/accounts/{accountId}/entries/{entryId}/reverse`
**Auth**: Required (ADMIN only)

### Request
```json
POST /api/v1/accounts/acc_uuid/entries/entry_uuid/reverse
{
  "reason": "Erroneous entry - duplicate",
  "requestId": "req_20251103_004"
}
```

### Response (201)
```json
{
  "success": true,
  "data": {
    "originalEntry": {
      "id": "entry_uuid",
      "valueSigned": 1500000.00
    },
    "reversalEntry": {
      "id": "reversal_uuid",
      "valueSigned": -1500000.00,
      "note": "Reversal of entry_uuid - Erroneous entry - duplicate",
      "createdAt": "2025-11-03T14:35:00Z"
    }
  }
}
```

---

## 11. GET BALANCE SUMMARY
**Endpoint**: `GET /api/v1/accounts/{accountId}/summary`
**Auth**: Required (all roles)

### Request
```
GET /api/v1/accounts/acc_uuid/summary
```

### Response (200)
```json
{
  "success": true,
  "data": {
    "accountId": "acc_uuid",
    "balance": 1500000.00,
    "totalDebits": 2700000.00,
    "totalCredits": 1200000.00,
    "entryCount": 150,
    "lastEntry": "2025-11-03T14:00:00Z"
  }
}
```

---

## 12. GET DAILY LEDGER SUMMARY
**Endpoint**: `GET /api/v1/accounts/{accountId}/ledger-summary`
**Auth**: Required (all roles)

### Request
```
GET /api/v1/accounts/acc_uuid/ledger-summary?from=2025-11-01&to=2025-11-03
```

### Response (200)
```json
{
  "success": true,
  "data": {
    "accountId": "acc_uuid",
    "period": {
      "from": "2025-11-01",
      "to": "2025-11-03"
    },
    "dailySummary": [
      {
        "date": "2025-11-01",
        "openingBalance": 0,
        "totalDebits": 1500000.00,
        "totalCredits": 0,
        "closingBalance": 1500000.00,
        "cxcStatus": "CXC",
        "cxcAmount": 1500000.00
      },
      {
        "date": "2025-11-02",
        "openingBalance": 1500000.00,
        "totalDebits": 2000000.00,
        "totalCredits": 1200000.00,
        "closingBalance": 2300000.00,
        "cxcStatus": "CXC",
        "cxcAmount": 2300000.00
      }
    ]
  }
}
```

---

## 13. CREATE BANK DEPOSIT
**Endpoint**: `POST /api/v1/accounts/{accountId}/deposits`
**Auth**: Required (all roles)

### Request
```json
POST /api/v1/accounts/acc_uuid/deposits
{
  "date": "2025-11-03",
  "docNumber": "DEP-20251103-001",
  "amount": 500000.00,
  "bankName": "Banco Nacional",
  "note": "Deposit of weekly sales",
  "receiptUrl": "https://...",
  "requestId": "req_20251103_005"
}
```

### Response (201)
```json
{
  "success": true,
  "data": {
    "id": "deposit_uuid",
    "accountId": "acc_uuid",
    "date": "2025-11-03",
    "docNumber": "DEP-20251103-001",
    "amount": 500000.00,
    "bankName": "Banco Nacional",
    "note": "Deposit of weekly sales",
    "receiptUrl": "https://...",
    "createdAt": "2025-11-03T14:30:00Z",
    "createdBy": "user_uuid"
  }
}
```

---

## 14. CREATE PAYMENT DOCUMENT
**Endpoint**: `POST /api/v1/accounts/payments`
**Auth**: Required (all roles)

### Request
```json
POST /api/v1/accounts/payments
{
  "fromAccountId": "acc_uuid_1",
  "toAccountId": "acc_uuid_2",
  "amount": 250000.00,
  "docNumber": "PAY-20251103-001",
  "date": "2025-11-03",
  "description": "Payment for settlement",
  "receiptUrl": "https://...",
  "requestId": "req_20251103_006"
}
```

### Response (201)
```json
{
  "success": true,
  "data": {
    "id": "payment_uuid",
    "fromAccountId": "acc_uuid_1",
    "toAccountId": "acc_uuid_2",
    "amount": 250000.00,
    "docNumber": "PAY-20251103-001",
    "date": "2025-11-03",
    "description": "Payment for settlement",
    "status": "COMPLETED",
    "createdAt": "2025-11-03T14:30:00Z"
  }
}
```

---

## 15. CREATE DAILY SNAPSHOT
**Endpoint**: `POST /api/v1/accounts/{accountId}/snapshots`
**Auth**: Required (all roles)

### Request
```json
POST /api/v1/accounts/acc_uuid/snapshots
{
  "date": "2025-11-03",
  "opening": 2300000.00,
  "debit": 1500000.00,
  "credit": 1200000.00,
  "closing": 2600000.00
}
```

### Response (201)
```json
{
  "success": true,
  "data": {
    "id": "snapshot_uuid",
    "accountId": "acc_uuid",
    "date": "2025-11-03",
    "opening": 2300000.00,
    "debit": 1500000.00,
    "credit": 1200000.00,
    "closing": 2600000.00,
    "createdAt": "2025-11-03T17:00:00Z"
  }
}
```

---

## 16. GET DAILY SNAPSHOTS
**Endpoint**: `GET /api/v1/accounts/{accountId}/snapshots`
**Auth**: Required (all roles)

### Request
```
GET /api/v1/accounts/acc_uuid/snapshots?from=2025-11-01&to=2025-11-03
```

### Response (200)
```json
{
  "success": true,
  "data": {
    "snapshots": [
      {
        "id": "snapshot_uuid",
        "date": "2025-11-01",
        "opening": 0,
        "debit": 1500000.00,
        "credit": 0,
        "closing": 1500000.00
      },
      {
        "id": "snapshot_uuid",
        "date": "2025-11-02",
        "opening": 1500000.00,
        "debit": 2000000.00,
        "credit": 1200000.00,
        "closing": 2300000.00
      }
    ]
  }
}
```

---

## 17. GET DAILY SUMMARY
**Endpoint**: `GET /api/v1/accounts/{accountId}/daily-summary`
**Auth**: Required (all roles)

### Request
```
GET /api/v1/accounts/acc_uuid/daily-summary?date=2025-11-03
```

### Response (200)
```json
{
  "success": true,
  "data": {
    "accountId": "acc_uuid",
    "date": "2025-11-03",
    "openingBalance": 2300000.00,
    "sales": 1500000.00,
    "prizes": 1200000.00,
    "commission": 45000.00,
    "netOperative": 645000.00,
    "closingBalance": 2945000.00,
    "entryCount": 15
  }
}
```

---

## 18. CLOSE DAY
**Endpoint**: `POST /api/v1/accounts/{accountId}/daily-close`
**Auth**: Required (all roles)

### Request
```json
POST /api/v1/accounts/acc_uuid/daily-close
{
  "date": "2025-11-03"
}
```

### Response (201)
```json
{
  "success": true,
  "data": {
    "accountId": "acc_uuid",
    "date": "2025-11-03",
    "openingBalance": 2300000.00,
    "totalDebits": 1500000.00,
    "totalCredits": 1200000.00,
    "closingBalance": 2600000.00,
    "status": "CLOSED",
    "closedAt": "2025-11-03T17:30:00Z"
  }
}
```

---

## 19. CALCULATE MAJORIZATION
**Endpoint**: `POST /api/v1/accounts/{accountId}/mayorizations/calculate`
**Auth**: Required (all roles)

### Request
```
POST /api/v1/accounts/acc_uuid/mayorizations/calculate?fromDate=2025-11-01&toDate=2025-11-03
```

**Query Parameters**:
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `fromDate` | string | Yes | Start date (YYYY-MM-DD) |
| `toDate` | string | Yes | End date (YYYY-MM-DD) |
| `includeDesglose` | boolean | No | Include detailed breakdown |

### Response (201)
```json
{
  "success": true,
  "data": {
    "id": "maj_uuid",
    "accountId": "acc_uuid",
    "ownerType": "VENTANA",
    "ownerId": "user_uuid",
    "ownerCode": "VEN-001",
    "ownerName": "Ventana San José",
    "fromDate": "2025-11-01",
    "toDate": "2025-11-03",
    "totalSales": 5000000.00,
    "totalPrizes": 4000000.00,
    "totalCommission": 150000.00,
    "netOperative": 1150000.00,
    "debtStatus": "CXC",
    "debtAmount": 1150000.00,
    "debtDescription": "Le debemos ₡1,150,000 al listero",
    "status": "OPEN",
    "isSettled": false,
    "createdAt": "2025-11-03T17:00:00Z"
  }
}
```

### Response Fields
| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Unique majorization ID (for settlement) |
| `totalSales` | Decimal | Sum of all ticket amounts in period |
| `totalPrizes` | Decimal | Sum of all paid prizes in period |
| `totalCommission` | Decimal | Sum of commission amounts in period |
| `netOperative` | Decimal | Net balance: totalSales - totalPrizes |
| `debtStatus` | String | "CXC" (we owe), "CXP" (they owe), "BALANCE" (even) |
| `debtAmount` | Decimal | Amount owed (absolute value) |
| `ownerCode` | String | Owner's unique code (Ventana or User) |
| `status` | String | "OPEN" (not settled) or "SETTLED" |

---

## 20. GET MAJORIZATION HISTORY
**Endpoint**: `GET /api/v1/accounts/mayorizations/history`
**Auth**: Required (all roles - RBAC auto-filters)

### Request
```
GET /api/v1/accounts/mayorizations/history?period=week&ownerType=VENTANA&isSettled=false&page=1&pageSize=20&orderBy=date&order=desc
```

**Query Parameters**:
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `period` | string | No | week | today, yesterday, week, month, year, range |
| `fromDate` | string | No | - | Start date (YYYY-MM-DD), required if period=range |
| `toDate` | string | No | - | End date (YYYY-MM-DD), required if period=range |
| `ownerType` | string | No | - | VENTANA or VENDEDOR |
| `ownerId` | UUID | No | - | Filter by owner ID |
| `debtStatus` | string | No | - | CXC, CXP, or BALANCE |
| `isSettled` | boolean | No | - | true or false |
| `page` | number | No | 1 | Page number |
| `pageSize` | number | No | 20 | Records per page |
| `orderBy` | string | No | date | date, debtAmount, netOperative |
| `order` | string | No | desc | asc or desc |

### Response (200)
```json
{
  "success": true,
  "mayorizations": [
    {
      "id": "maj_uuid",
      "ownerId": "user_uuid",
      "ownerCode": "VEN-001",
      "ownerName": "Ventana San José",
      "ownerType": "VENTANA",
      "date": "2025-11-03",
      "totalSales": 5000000.00,
      "totalPrizes": 4000000.00,
      "totalCommission": 150000.00,
      "netOperative": 1150000.00,
      "debtStatus": "CXC",
      "debtAmount": 1150000.00,
      "debtDescription": "Le debemos ₡1,150,000 al listero",
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
    "totalDebtAmount": 5750000.00,
    "totalSettledAmount": 0,
    "pendingSettlement": 5750000.00
  }
}
```

### Response Field Mapping

**Mayorizations Array** - Each item contains:
| Field | Type | Key Info |
|-------|------|----------|
| `id` | UUID | **Use for settlement** |
| `totalSales` | Decimal | Total ticket amounts |
| `totalPrizes` | Decimal | Total paid prizes |
| `totalCommission` | Decimal | Total commission earned |
| `ownerCode` | String | Ventana/Vendedor code |
| `ownerName` | String | Display name |
| `debtStatus` | String | CXC/CXP/BALANCE |
| `debtAmount` | Decimal | **Amount to pay/collect** |
| `status` | String | OPEN (unsettled) / SETTLED |

**Pagination** - Always included:
| Field | Type | Purpose |
|-------|------|---------|
| `page` | number | Current page |
| `pageSize` | number | Records per page |
| `total` | number | Total records |
| `totalPages` | number | Total pages |

**Summary** - Aggregate totals:
| Field | Type | Description |
|-------|------|-------------|
| `totalDebtAmount` | Decimal | Sum of all CXC amounts (we owe listero) |
| `totalSettledAmount` | Decimal | Sum of already settled amounts |
| `pendingSettlement` | Decimal | Sum of unsettled CXC amounts |

---

## 21. SETTLE MAJORIZATION
**Endpoint**: `POST /api/v1/accounts/mayorizations/settle`
**Auth**: Required (all roles)

### Request
```json
POST /api/v1/accounts/mayorizations/settle
{
  "mayorizationId": "maj_uuid",
  "amount": 1150000.00,
  "settlementType": "PAYMENT",
  "date": "2025-11-03",
  "reference": "CHK-004567",
  "note": "Payment via check",
  "requestId": "req_20251103_007"
}
```

### Response (201)
```json
{
  "success": true,
  "data": {
    "mayorization": {
      "id": "maj_uuid",
      "accountId": "acc_uuid",
      "ownerType": "VENTANA",
      "ownerId": "user_uuid",
      "totalSales": 5000000.00,
      "totalPrizes": 4000000.00,
      "totalCommission": 150000.00,
      "netOperative": 1150000.00,
      "debtStatus": "CXC",
      "debtAmount": 1150000.00,
      "status": "SETTLED",
      "isSettled": true,
      "settledDate": "2025-11-03",
      "settledAmount": 1150000.00,
      "settlementType": "PAYMENT",
      "settlementRef": "CHK-004567",
      "settledBy": "user_uuid"
    },
    "ledgerEntry": {
      "id": "entry_uuid",
      "accountId": "acc_uuid",
      "type": "ADJUSTMENT",
      "date": "2025-11-03",
      "valueSigned": -1150000.00,
      "note": "PAYMENT - Ref: CHK-004567 (Payment via check)",
      "referenceType": "ADJUSTMENT_DOC",
      "referenceId": "maj_uuid",
      "createdAt": "2025-11-03T17:30:00Z"
    },
    "newBalance": 3750000.00
  }
}
```

---

## 22. EXPORT STATEMENT
**Endpoint**: `GET /api/v1/accounts/{accountId}/statement/export`
**Auth**: Required (all roles)

### Request
```
GET /api/v1/accounts/acc_uuid/statement/export?from=2025-11-01&to=2025-11-03
```

### Response (200)
```
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
Content-Disposition: attachment; filename="statement_acc_uuid_20251101_20251103.xlsx"

[Excel file binary content]
```

Or (200) if response format is JSON:
```json
{
  "success": true,
  "data": {
    "fileName": "statement_acc_uuid_20251101_20251103.xlsx",
    "downloadUrl": "https://cdn.example.com/exports/...",
    "expiresAt": "2025-11-06T17:30:00Z"
  }
}
```

---

## STANDARD ERROR RESPONSES

All endpoints may return:

### 400 Bad Request
```json
{
  "success": false,
  "error": {
    "message": "Validation error",
    "code": "VALIDATION_ERROR",
    "details": [...]
  }
}
```

### 401 Unauthorized
```json
{
  "success": false,
  "error": {
    "message": "Authentication required",
    "code": "AUTH_REQUIRED"
  }
}
```

### 403 Forbidden
```json
{
  "success": false,
  "error": {
    "message": "Insufficient permissions",
    "code": "FORBIDDEN"
  }
}
```

### 404 Not Found
```json
{
  "success": false,
  "error": {
    "message": "Resource not found",
    "code": "NOT_FOUND"
  }
}
```

### 409 Conflict
```json
{
  "success": false,
  "error": {
    "message": "Majorization is already settled",
    "code": "ALREADY_SETTLED"
  }
}
```

### 500 Internal Server Error
```json
{
  "success": false,
  "error": {
    "message": "Internal server error",
    "code": "INTERNAL_ERROR"
  }
}
```

---

## SUMMARY TABLE

| # | Method | Endpoint | Returns | Notes |
|---|--------|----------|---------|-------|
| 1 | GET | `/accounts` | accounts[] + meta | Paginated list |
| 2 | POST | `/accounts` | account (201) | ADMIN only |
| 3 | GET | `/accounts/{id}` | account | Single account |
| 4 | GET | `/accounts/{id}/balance` | balance | Quick balance check |
| 5 | PUT | `/accounts/{id}` | account | ADMIN only |
| 6 | GET | `/accounts/{id}/entries` | entries[] + meta | Ledger entries |
| 7 | POST | `/accounts/{id}/entries/sale` | entry (201) | Add sale |
| 8 | POST | `/accounts/{id}/entries/commission` | entry (201) | Add commission |
| 9 | POST | `/accounts/{id}/entries/payout` | entry (201) | Add payout |
| 10 | POST | `/accounts/{id}/entries/{id}/reverse` | reversal (201) | ADMIN only |
| 11 | GET | `/accounts/{id}/summary` | summary | Balance summary |
| 12 | GET | `/accounts/{id}/ledger-summary` | dailySummary[] | Daily breakdown |
| 13 | POST | `/accounts/{id}/deposits` | deposit (201) | Bank deposit |
| 14 | POST | `/accounts/payments` | payment (201) | Inter-account transfer |
| 15 | POST | `/accounts/{id}/snapshots` | snapshot (201) | Create snapshot |
| 16 | GET | `/accounts/{id}/snapshots` | snapshots[] | Get snapshots |
| 17 | GET | `/accounts/{id}/daily-summary` | daily (200) | One day summary |
| 18 | POST | `/accounts/{id}/daily-close` | closed (201) | Close day |
| 19 | POST | `/accounts/{id}/mayorizations/calculate` | majorization (201) | Create majorization |
| 20 | GET | `/accounts/mayorizations/history` | mayorizations[] + meta | History with pagination |
| 21 | POST | `/accounts/mayorizations/settle` | settlement (201) | Settle majorization |
| 22 | GET | `/accounts/{id}/statement/export` | file or URL (200) | Export statement |

---

## IMPLEMENTATION NOTES

1. **Standard Response Format**:
   - Use `success(res, data, meta)` from `utils/responses.ts`
   - Or `created(res, data)` for POST/PUT returning 201

2. **Error Handling**:
   - All errors should follow the error response structure
   - Include error code for frontend categorization
   - Log errors with context (action, userId, payload)

3. **Pagination**:
   - Endpoints 1, 6, 16, 20 support pagination
   - Return `meta` with `pagination` object
   - Default: page=1, pageSize=20

4. **Mayorization**:
   - Endpoint 20 returns `mayorizations` (plural) in `data`
   - Also includes `meta` with `pagination` and `summary`
   - Follows record-first architecture (must call 19 before 20)

5. **Validation**:
   - All request parameters validated with Zod schemas
   - Return 400 with validation error details if validation fails

6. **Authentication**:
   - All endpoints require auth token
   - Some endpoints require ADMIN role
   - RBAC filtering applied for VENTANA/VENDEDOR roles

7. **Idempotency**:
   - Endpoints 7-9, 13-15, 18, 21 support `requestId` parameter
   - Prevents duplicate processing if request is retried

8. **Activity Logging**:
   - All write operations log to ActivityLog
   - Error responses also logged for 4xx+ status

