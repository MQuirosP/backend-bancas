# Universal Date Parameter Standard for Backend APIs

**Status**: ✅ FINAL & ENFORCED
**Date**: 2025-10-27
**Version**: 1.0
**Effective**: All endpoints must follow this standard (no exceptions)

---

## Executive Summary

This document defines the **UNIVERSAL and MANDATORY** date parameter standard for ALL endpoints in the backend that accept date filtering.

**One Standard. Zero Exceptions.**

Every endpoint that filters by date MUST follow this pattern. No variations. No shortcuts.

---

## The Standard

### Query Parameter Format

```
?date={token}&fromDate={YYYY-MM-DD}&toDate={YYYY-MM-DD}
```

### Required Parameters

#### 1. Date Token Parameter

**Name**: `date`
**Type**: String (enum)
**Default**: `"today"`
**Validation**: Must be one of 6 values

```typescript
date: z.enum([
  "today",     // Current day in CR timezone
  "yesterday", // Previous day
  "week",      // Current week (Monday-Sunday)
  "month",     // Current calendar month
  "year",      // Current calendar year
  "range"      // Custom date range
])
```

#### 2. Custom Range Parameters (if date=range)

**Name**: `fromDate`
**Type**: String
**Format**: `YYYY-MM-DD` (strictly, using regex `/^\d{4}-\d{2}-\d{2}$/`)
**Required**: Only when `date=range`
**Example**: `2025-10-01`

**Name**: `toDate`
**Type**: String
**Format**: `YYYY-MM-DD` (strictly, using regex `/^\d{4}-\d{2}-\d{2}$/`)
**Required**: Only when `date=range`
**Example**: `2025-10-27`

### Interpretation by Backend

All dates are **interpreted in Costa Rica timezone** (America/Costa_Rica, UTC-6):

```
fromDate=2025-10-01  →  2025-10-01 00:00:00 CR
                     →  2025-10-01T06:00:00.000Z (UTC)

toDate=2025-10-27    →  2025-10-27 23:59:59 CR
                     →  2025-10-28T05:59:59.999Z (UTC)
```

**No timezone conversion by frontend required.** Just send the date as-is.

### Response Format

All timestamps in responses are **ISO 8601 UTC**:

```json
{
  "createdAt": "2025-10-27T06:00:00.000Z",
  "updatedAt": "2025-10-28T05:59:59.999Z"
}
```

Metadata includes range resolution:

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

## What the Frontend Must Send

### Example 1: Today's Data

```bash
GET /api/v1/ventas?date=today
```

**What frontend sends**: Only `date=today`
**What backend calculates**: Entire day from 00:00:00 to 23:59:59 CR
**No timezone handling needed on frontend**

### Example 2: This Week

```bash
GET /api/v1/admin/dashboard?date=week
```

**What frontend sends**: Only `date=week`
**What backend calculates**: Monday to Sunday of current week in CR
**No date math needed on frontend**

### Example 3: Custom Range

```bash
GET /api/v1/ventas?date=range&fromDate=2025-10-01&toDate=2025-10-27
```

**What frontend sends**:
- `date=range`
- `fromDate=2025-10-01` (user's date picker selection)
- `toDate=2025-10-27` (user's date picker selection)

**Important: Send as YYYY-MM-DD, NOT ISO datetime**

```javascript
// ✅ CORRECT
const from = new Date(2025, 9, 1)  // Oct 1
const to = new Date(2025, 9, 27)   // Oct 27
fetch(`/api/v1/ventas?date=range&fromDate=${formatYYYYMMDD(from)}&toDate=${formatYYYYMMDD(to)}`)

function formatYYYYMMDD(d) {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
```

```javascript
// ❌ WRONG - Don't send ISO datetime
fetch(`/api/v1/ventas?date=range&from=${new Date().toISOString()}&to=${new Date().toISOString()}`)
```

---

## Complete Endpoint List (After Standardization)

### All Endpoints Using Universal Standard

#### Venta/Sales Module (5 endpoints)

```
GET /api/v1/ventas
GET /api/v1/ventas/summary
GET /api/v1/ventas/breakdown
GET /api/v1/ventas/timeseries
GET /api/v1/ventas/facets
```

**Parameters**:
- `date` (required): today|yesterday|week|month|year|range
- `fromDate` (optional): YYYY-MM-DD (if date=range)
- `toDate` (optional): YYYY-MM-DD (if date=range)
- Plus other filters: status, winnersOnly, bancaId, etc.

#### Dashboard Module (4 endpoints)

```
GET /api/v1/admin/dashboard
GET /api/v1/admin/dashboard/ganancia
GET /api/v1/admin/dashboard/cxc
GET /api/v1/admin/dashboard/cxp
```

**Parameters**: Same as Venta module

#### Tickets Module (1 endpoint)

```
GET /api/v1/tickets
```

**Parameters**: Same as Venta module

#### Ticket Payments Module (1 endpoint)

```
GET /api/v1/ticket-payments
```

**Parameters**: Same as Venta module (date enum + fromDate/toDate)

---

## Frontend Implementation Rules

### Rule 1: Never Calculate Dates on Frontend

❌ **NEVER DO THIS**:
```javascript
const now = new Date()
const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000)
fetch(`/api/data?from=${sevenDaysAgo.toISOString()}&to=${now.toISOString()}`)
```

✅ **DO THIS INSTEAD**:
```javascript
fetch(`/api/data?date=week`)
```

**Why**: Client time can be wrong, timezone confusion, inconsistent results. Server is authority.

### Rule 2: Use Semantic Tokens When Possible

✅ Prefer tokens:
```
?date=today
?date=yesterday
?date=week
?date=month
?date=year
```

❌ Avoid custom ranges unless user explicitly selects:
```
?date=range&fromDate=...&toDate=...
```

Custom ranges should only come from user selections (date picker), never calculated.

### Rule 3: Format Dates as YYYY-MM-DD

✅ **CORRECT**:
```
fromDate=2025-10-01
toDate=2025-10-27
```

❌ **WRONG**:
```
fromDate=2025-10-01T00:00:00Z    (ISO datetime - DON'T)
fromDate=10/01/2025              (MM/DD/YYYY format - DON'T)
fromDate=2025/10/01              (wrong separator - DON'T)
```

### Rule 4: Let Backend Handle Timezone

✅ **CORRECT** - Backend interprets dates in CR timezone:
```javascript
// User in any timezone selects Oct 1, 2025
const selected = new Date(2025, 9, 1)
const formatted = formatYYYYMMDD(selected)  // "2025-10-01"
fetch(`/api/ventas?date=range&fromDate=${formatted}&toDate=...`)
// Backend: 2025-10-01 00:00:00 CR (converts to UTC internally)
```

❌ **WRONG** - Don't try to convert to CR timezone:
```javascript
const crOffset = -6 * 60  // UTC-6
const crTime = new Date(date.getTime() + crOffset * 60 * 1000)  // DON'T DO THIS
fetch(`/api/ventas?date=range&fromDate=${crTime.toISOString()}&toDate=...`)
```

---

## Error Handling

### Invalid Date Token

**Request**:
```bash
GET /api/v1/ventas?date=thisWeek
```

**Response** (400):
```json
{
  "success": false,
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

**Frontend should**:
- Show user error: "Invalid date selection"
- Check browser console for details
- Log error with request ID for support

### Invalid Date Format

**Request**:
```bash
GET /api/v1/ventas?date=range&fromDate=10/01/2025&toDate=2025-10-27
```

**Response** (400):
```json
{
  "success": false,
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

### Missing Required Parameters for Range

**Request**:
```bash
GET /api/v1/ventas?date=range
```

**Response** (400):
```json
{
  "success": false,
  "error": {
    "code": "SLS_2001",
    "message": "fromDate and toDate required for date=range",
    "details": [
      {
        "field": "fromDate",
        "reason": "Required when date=range"
      }
    ]
  }
}
```

---

## Token Resolution Reference

### Token: `today`

**When to use**: Current calendar day

**Example request**: `?date=today` (sent today, Oct 27)

**Backend calculates**:
- fromAt: 2025-10-27T06:00:00.000Z (Oct 27 00:00 CR)
- toAt: 2025-10-28T05:59:59.999Z (Oct 27 23:59:59 CR)

**Result**: All transactions from midnight to 23:59:59 of today

---

### Token: `yesterday`

**When to use**: Previous calendar day

**Example request**: `?date=yesterday` (sent today, Oct 27)

**Backend calculates**:
- fromAt: 2025-10-26T06:00:00.000Z (Oct 26 00:00 CR)
- toAt: 2025-10-27T05:59:59.999Z (Oct 26 23:59:59 CR)

**Result**: All transactions from yesterday

---

### Token: `week`

**When to use**: Current calendar week (Monday-Sunday)

**Example request**: `?date=week` (sent on Wed Oct 29)

**Backend calculates**:
- Week start: Monday Oct 27, 2025
- Week end: Sunday Nov 2, 2025
- fromAt: 2025-10-27T06:00:00.000Z (Mon 00:00 CR)
- toAt: 2025-11-03T05:59:59.999Z (Sun 23:59:59 CR)

**Result**: All transactions from Monday 00:00 to Sunday 23:59

---

### Token: `month`

**When to use**: Current calendar month

**Example request**: `?date=month` (sent on Oct 27)

**Backend calculates**:
- fromAt: 2025-10-01T06:00:00.000Z (Oct 1 00:00 CR)
- toAt: 2025-11-01T05:59:59.999Z (Oct 31 23:59:59 CR)

**Result**: All transactions from 1st to last day of month

---

### Token: `year`

**When to use**: Current calendar year

**Example request**: `?date=year` (sent on Oct 27)

**Backend calculates**:
- fromAt: 2025-01-01T06:00:00.000Z (Jan 1 00:00 CR)
- toAt: 2026-01-01T05:59:59.999Z (Dec 31 23:59:59 CR)

**Result**: All transactions from Jan 1 to Dec 31

---

### Token: `range`

**When to use**: Custom date range (user selected via date picker)

**Example request**: `?date=range&fromDate=2025-10-01&toDate=2025-10-27`

**Backend calculates**:
- fromAt: 2025-10-01T06:00:00.000Z (Oct 1 00:00 CR)
- toAt: 2025-10-28T05:59:59.999Z (Oct 27 23:59:59 CR)

**Result**: All transactions from selected from date to selected to date (inclusive)

---

## Implementation Checklist for Frontend

Before asking backend to deploy, frontend must:

- [ ] Update all API calls to use `date` enum tokens
- [ ] Remove all client-side date calculations
- [ ] Format custom dates as YYYY-MM-DD
- [ ] Never send ISO datetime strings for date filtering
- [ ] Test all 6 date tokens
- [ ] Test custom range selection
- [ ] Test error cases (invalid tokens, bad format)
- [ ] Verify timezone-agnostic (works in any timezone)
- [ ] Update all date picker/selector logic
- [ ] Remove any `moment.tz`, `date-fns/tz` usage for API calls
- [ ] Document date parameter usage in comments
- [ ] Test on multiple machines with different system times

---

## Validation Schema (For Reference)

All endpoints use this schema structure (or a superset):

```typescript
const DateFilterSchema = z.object({
  date: z
    .enum(["today", "yesterday", "week", "month", "year", "range"])
    .optional()
    .default("today"),
  fromDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  toDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
})
```

Every endpoint with date filtering validates against this exact schema.

---

## Timezone Guarantee

**Backend Guarantee**:
> All date parameters sent with values `today`, `yesterday`, `week`, `month`, `year` are interpreted in **America/Costa_Rica timezone** (UTC-6, fixed, no DST). Custom ranges with `fromDate`/`toDate` are also interpreted in CR timezone. The same request sent at different times always returns the same data for the same date token.

**Frontend Obligation**:
> Send YYYY-MM-DD dates without timezone conversion. Never send ISO datetime strings. Trust backend to interpret correctly.

---

## No Exceptions Policy

This standard applies to:
- ✅ All query parameters
- ✅ All GET endpoints with date filtering
- ✅ All date comparison operations
- ✅ All dashboards and reports
- ✅ All exports (when date-filtered)

Endpoints that don't have date filtering:
- Users list, Ventanas list, Lotteries list, etc. → Use pagination only
- Restriction rules (body dates), Commission policies (body dates), Multipliers (body dates) → Different use case (not for query filtering)

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2025-10-27 | Initial standard (enforced for all endpoints) |

---

## Questions?

Refer to:
1. **PARAMETER_VALIDATION_AUDIT.md** - What was wrong and how we fixed it
2. **API_ENDPOINT_PARAMETERS_REFERENCE.md** - Detailed endpoint reference
3. **FRONTEND_DATE_STRATEGY.md** - Frontend implementation guide
4. **DATE_TESTING_CHECKLIST.md** - QA testing plan

---

**Status**: ✅ FINAL & MANDATORY
**No Variations. No Exceptions. One Standard.**

