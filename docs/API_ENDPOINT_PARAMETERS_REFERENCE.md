# API Endpoint Parameters Reference

**Date**: 2025-10-27
**Status**: ✅ VERIFIED & COMPLETE
**Last Updated**: After parameter validation audit fix

---

## Quick Reference

All endpoints now support **6 date tokens**:
- `today` - Current day in CR timezone
- `yesterday` - Previous day
- `week` - Current week (Monday to Sunday)
- `month` - Current calendar month
- `year` - Current calendar year
- `range` - Custom date range with `fromDate` and `toDate`

---

## Sales (Ventas) Module

### GET /api/v1/ventas - List all sales

**Parameters**:
```
date              enum: [today, yesterday, week, month, year, range] (default: today)
fromDate          YYYY-MM-DD format, required if date=range
toDate            YYYY-MM-DD format, required if date=range
page              integer, default: 1
pageSize          integer, default: 20, max: 100
scope             enum: [mine, all] (RBAC applied automatically)
status            enum: [ACTIVE, EVALUATED, CANCELLED, RESTORED]
winnersOnly       boolean, default: false
bancaId           UUID
ventanaId         UUID
vendedorId        UUID
loteriaId         UUID
sorteoId          UUID
search            string, max: 100 chars
orderBy           string
```

**Validator**: ListVentasQuerySchema
**Timezone**: CR (UTC-6) - interpreted by backend

**Examples**:
```bash
# Today's sales
GET /api/v1/ventas?date=today

# This week's sales
GET /api/v1/ventas?date=week

# Custom range
GET /api/v1/ventas?date=range&fromDate=2025-10-01&toDate=2025-10-27

# With filtering
GET /api/v1/ventas?date=week&status=ACTIVE&winnersOnly=true&page=1&pageSize=50
```

---

### GET /api/v1/ventas/summary - Aggregated metrics (KPI)

**Parameters**:
```
date              enum: [today, yesterday, week, month, year, range] (default: today)
fromDate          YYYY-MM-DD format, required if date=range
toDate            YYYY-MM-DD format, required if date=range
scope             enum: [mine, all]
status            enum: [ACTIVE, EVALUATED, CANCELLED, RESTORED]
winnersOnly       boolean
bancaId           UUID
ventanaId         UUID
vendedorId        UUID
loteriaId         UUID
sorteoId          UUID
```

**Validator**: VentasSummaryQuerySchema
**Response**: Total count, sum, average, etc.

**Examples**:
```bash
# Today's summary
GET /api/v1/ventas/summary?date=today

# Month's summary
GET /api/v1/ventas/summary?date=month

# Custom range with filters
GET /api/v1/ventas/summary?date=range&fromDate=2025-10-01&toDate=2025-10-27&status=EVALUATED
```

---

### GET /api/v1/ventas/breakdown - Segmented by dimension

**Parameters**:
```
dimension         enum: [ventana, vendedor, loteria, sorteo, numero] (REQUIRED)
top               integer, default: 10, max: 50
date              enum: [today, yesterday, week, month, year, range] (default: today)
fromDate          YYYY-MM-DD format, required if date=range
toDate            YYYY-MM-DD format, required if date=range
scope             enum: [mine, all]
status            enum: [ACTIVE, EVALUATED, CANCELLED, RESTORED]
winnersOnly       boolean
bancaId           UUID
ventanaId         UUID
vendedorId        UUID
loteriaId         UUID
sorteoId          UUID
```

**Validator**: VentasBreakdownQuerySchema
**Response**: Array of dimension values with metrics

**Examples**:
```bash
# Top 10 ventanas this week
GET /api/v1/ventas/breakdown?dimension=ventana&date=week&top=10

# Top 20 sellers today
GET /api/v1/ventas/breakdown?dimension=vendedor&date=today&top=20

# Top lotteries for month
GET /api/v1/ventas/breakdown?dimension=loteria&date=month&top=5
```

---

### GET /api/v1/ventas/timeseries - Time-based trends

**Parameters**:
```
granularity       enum: [hour, day, week] (default: day)
date              enum: [today, yesterday, week, month, year, range] (default: today)
fromDate          YYYY-MM-DD format, required if date=range
toDate            YYYY-MM-DD format, required if date=range
scope             enum: [mine, all]
status            enum: [ACTIVE, EVALUATED, CANCELLED, RESTORED]
winnersOnly       boolean
bancaId           UUID
ventanaId         UUID
vendedorId        UUID
loteriaId         UUID
sorteoId          UUID
```

**Validator**: VentasTimeseriesQuerySchema
**Response**: Array of time periods with metrics

**Range Limits**:
- `hour` granularity: max 30 days
- `day` granularity: max 90 days
- `week` granularity: no limit

**Examples**:
```bash
# This week's daily data
GET /api/v1/ventas/timeseries?date=week&granularity=day

# Hourly data for today
GET /api/v1/ventas/timeseries?date=today&granularity=hour

# Custom range with daily breakdown
GET /api/v1/ventas/timeseries?date=range&fromDate=2025-10-01&toDate=2025-10-27&granularity=day
```

---

### GET /api/v1/ventas/facets - Available filter values

**Parameters**:
```
date              enum: [today, yesterday, week, month, year, range] (default: today)
fromDate          YYYY-MM-DD format, required if date=range
toDate            YYYY-MM-DD format, required if date=range
scope             enum: [mine, all]
```

**Validator**: FacetsQuerySchema
**Response**: Distinct values for bancas, ventanas, vendedores, etc.

**Examples**:
```bash
# Today's available filter values
GET /api/v1/ventas/facets?date=today

# Month's available values
GET /api/v1/ventas/facets?date=month
```

---

## Dashboard Module

### GET /api/v1/admin/dashboard - Main dashboard

**Parameters**:
```
date              enum: [today, yesterday, week, month, year, range] (default: today)
fromDate          YYYY-MM-DD format, required if date=range
toDate            YYYY-MM-DD format, required if date=range
ventanaId         UUID (optional, VENTANA role always filters to own)
scope             enum: [mine, all] (optional)
```

**Validator**: DashboardQuerySchema
**RBAC**: VENDEDOR (forbidden), VENTANA (own only), ADMIN (all)
**Response**: Ganancia, CxC, CxP metrics in one call

**Examples**:
```bash
# Today's dashboard
GET /api/v1/admin/dashboard?date=today

# Week's metrics
GET /api/v1/admin/dashboard?date=week

# Specific ventana (ADMIN only)
GET /api/v1/admin/dashboard?date=month&ventanaId=uuid-here

# Custom range
GET /api/v1/admin/dashboard?date=range&fromDate=2025-10-01&toDate=2025-10-27
```

---

### GET /api/v1/admin/dashboard/ganancia - Commission revenue

**Parameters**: Same as main dashboard
```
date              enum: [today, yesterday, week, month, year, range] (default: today)
fromDate          YYYY-MM-DD format, required if date=range
toDate            YYYY-MM-DD format, required if date=range
ventanaId         UUID (optional)
scope             enum: [mine, all] (optional)
```

**Validator**: DashboardQuerySchema
**Response**: Commission totals by dimension

**Examples**:
```bash
# Today's commissions
GET /api/v1/admin/dashboard/ganancia?date=today

# This year's commissions
GET /api/v1/admin/dashboard/ganancia?date=year
```

---

### GET /api/v1/admin/dashboard/cxc - Accounts receivable

**Parameters**: Same as main dashboard
```
date              enum: [today, yesterday, week, month, year, range] (default: today)
fromDate          YYYY-MM-DD format, required if date=range
toDate            YYYY-MM-DD format, required if date=range
ventanaId         UUID (optional)
scope             enum: [mine, all] (optional)
```

**Validator**: DashboardQuerySchema
**Response**: CxC calculations (sales - prizes paid)

---

### GET /api/v1/admin/dashboard/cxp - Accounts payable

**Parameters**: Same as main dashboard
```
date              enum: [today, yesterday, week, month, year, range] (default: today)
fromDate          YYYY-MM-DD format, required if date=range
toDate            YYYY-MM-DD format, required if date=range
ventanaId         UUID (optional)
scope             enum: [mine, all] (optional)
```

**Validator**: DashboardQuerySchema
**Response**: CxP calculations (overpayment detection)

---

## Ticket Payments Module

### GET /api/v1/ticket-payments - List all payments

**Parameters**:
```
page              integer, default: 1
pageSize          integer, default: 20, max: 100
ticketId          UUID (optional)
ventanaId         UUID (optional)
vendedorId        UUID (optional)
status            enum: [pending, completed, reversed, partial] (optional)
fromDate          YYYY-MM-DD format (optional)
toDate            YYYY-MM-DD format (optional)
sortBy            enum: [createdAt, amountPaid, updatedAt] (default: createdAt)
sortOrder         enum: [asc, desc] (default: desc)
```

**Validator**: ListPaymentsQuerySchema
**Timezone**: CR (UTC-6) - date range interpreted by backend
**Note**: Uses direct date parameters, NOT date enum tokens

**Examples**:
```bash
# List all payments
GET /api/v1/ticket-payments?page=1&pageSize=20

# Payments for specific ticket
GET /api/v1/ticket-payments?ticketId=uuid-here

# Date range filtering
GET /api/v1/ticket-payments?fromDate=2025-10-01&toDate=2025-10-27

# By status
GET /api/v1/ticket-payments?status=completed

# Combined
GET /api/v1/ticket-payments?vendedorId=uuid&status=partial&fromDate=2025-10-20&toDate=2025-10-27&sortBy=amountPaid
```

---

### POST /api/v1/ticket-payments - Create payment

**Body Parameters**:
```
ticketId          UUID (REQUIRED)
amountPaid        number, must be positive (REQUIRED)
method            enum: [CASH, CHECK, TRANSFER, OTHER] (REQUIRED)
isFinal           boolean, marks partial payment as complete (optional)
notes             string, max: 300 chars (optional)
idempotencyKey    string, for request deduplication (optional)
```

**Validator**: CreatePaymentSchema
**Response**: Created payment object with ID, status, timestamp

**Example**:
```bash
POST /api/v1/ticket-payments
{
  "ticketId": "uuid-here",
  "amountPaid": 10000,
  "method": "CASH",
  "isFinal": false,
  "notes": "Partial payment received",
  "idempotencyKey": "unique-key-123"
}
```

---

### PUT /api/v1/ticket-payments/:id - Update payment (finalize)

**Body Parameters**:
```
isFinal           boolean (optional)
notes             string, max: 300 chars (optional)
```

**Validator**: UpdatePaymentSchema

**Example**:
```bash
PUT /api/v1/ticket-payments/uuid-here
{
  "isFinal": true,
  "notes": "Final payment received"
}
```

---

### DELETE /api/v1/ticket-payments/:id - Reverse payment

**Parameters**: None (ID in path)

**Response**: Confirmation of reversal, ticket status restored

**Example**:
```bash
DELETE /api/v1/ticket-payments/uuid-here
```

---

### GET /api/v1/ticket-payments/:id - Get payment details

**Parameters**: ID in path only

**Response**: Full payment object with related ticket info

**Example**:
```bash
GET /api/v1/ticket-payments/uuid-here
```

---

### GET /api/v1/ticket-payments/:id/history - Payment audit trail

**Parameters**: ID in path only

**Response**: Complete history of payment changes and reversals

**Example**:
```bash
GET /api/v1/ticket-payments/uuid-here/history
```

---

## Date Format Reference

### For Query Parameters

**Semantic Tokens** (supported in all Venta and Dashboard endpoints):
```
date=today
date=yesterday
date=week
date=month
date=year
```

**Custom Range** (with dates):
```
date=range&fromDate=2025-10-01&toDate=2025-10-27
```

**Date Format**: YYYY-MM-DD (no time component)
- `2025-10-01` → 2025-10-01 00:00:00 CR (06:00:00 UTC)
- `2025-10-27` → 2025-10-27 23:59:59 CR (05:59:59 UTC next day)

### In Responses

All timestamps returned as **ISO 8601 UTC**:
```json
{
  "createdAt": "2025-10-27T06:00:00.000Z",
  "updatedAt": "2025-10-28T05:59:59.999Z"
}
```

Date ranges in metadata:
```json
{
  "meta": {
    "range": {
      "fromAt": "2025-10-27T06:00:00.000Z",
      "toAt": "2025-10-28T05:59:59.999Z",
      "tz": "America/Costa_Rica",
      "description": "This week (2025-10-27 to 2025-11-02) in America/Costa_Rica"
    }
  }
}
```

---

## Error Responses

### Invalid Date Parameter

**Status**: 400
**Code**: SLS_2001
**Message**: Invalid date parameter

```json
{
  "error": {
    "code": "SLS_2001",
    "message": "Invalid date parameter",
    "details": [
      {
        "field": "date",
        "reason": "Must be one of: today, yesterday, week, month, year, range"
      }
    ]
  }
}
```

### Invalid Date Format

**Status**: 400
**Code**: SLS_2001

```json
{
  "error": {
    "code": "SLS_2001",
    "message": "Invalid fromDate format",
    "details": [
      {
        "field": "fromDate",
        "reason": "Use format YYYY-MM-DD"
      }
    ]
  }
}
```

### Future Date

**Status**: 400
**Code**: SLS_2001

```json
{
  "error": {
    "code": "SLS_2001",
    "details": [
      {
        "field": "toDate",
        "reason": "toDate must be ≤ today (2025-10-27)"
      }
    ]
  }
}
```

---

## RBAC & Scoping

### Venta Endpoints
- **VENDEDOR**: Sees only own sales (`vendedorId` filtered by role)
- **VENTANA**: Sees own window's sales (`ventanaId` filtered by role)
- **ADMIN**: Sees all sales

### Dashboard Endpoints
- **VENDEDOR**: 403 Forbidden
- **VENTANA**: Sees own window's metrics only
- **ADMIN**: Sees all metrics

### Ticket Payment Endpoints
- **VENDEDOR**: Sees own sales' payments
- **VENTANA**: Sees own window's payments
- **ADMIN**: Sees all payments

---

## Pagination

### For List Endpoints

**Parameters**:
```
page              integer, default: 1, min: 1
pageSize          integer, default: 20, min: 1, max: 100
```

**Response**:
```json
{
  "data": [ ... ],
  "meta": {
    "pagination": {
      "page": 1,
      "pageSize": 20,
      "totalCount": 150,
      "totalPages": 8
    }
  }
}
```

---

## Summary Table

| Endpoint | Module | Date Tokens | Format | RBAC |
|----------|--------|-------------|--------|------|
| /ventas | Sales | 6 tokens | YYYY-MM-DD | ✅ |
| /ventas/summary | Sales | 6 tokens | YYYY-MM-DD | ✅ |
| /ventas/breakdown | Sales | 6 tokens | YYYY-MM-DD | ✅ |
| /ventas/timeseries | Sales | 6 tokens | YYYY-MM-DD | ✅ |
| /ventas/facets | Sales | 6 tokens | YYYY-MM-DD | ✅ |
| /admin/dashboard | Dashboard | 6 tokens | YYYY-MM-DD | ✅ |
| /admin/dashboard/ganancia | Dashboard | 6 tokens | YYYY-MM-DD | ✅ |
| /admin/dashboard/cxc | Dashboard | 6 tokens | YYYY-MM-DD | ✅ |
| /admin/dashboard/cxp | Dashboard | 6 tokens | YYYY-MM-DD | ✅ |
| /ticket-payments | Payments | None (direct) | YYYY-MM-DD | ✅ |

---

**Status**: ✅ VERIFIED & ACCURATE
**Last Validation**: 2025-10-27 after parameter audit
**TypeScript**: ✅ All schemas compiled and validated

