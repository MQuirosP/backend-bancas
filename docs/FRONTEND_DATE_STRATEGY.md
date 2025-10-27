# Frontend Date Strategy - Backend Authority Model

**Date**: 2025-10-27
**Status**: ⚠️ CRITICAL - Requires Frontend Update
**Impact**: All API calls with date parameters must be updated

---

## The Problem: Client-Side Date Calculation is Insecure

The current frontend implementation calculates date ranges **on the client**:

```javascript
// ❌ WRONG: Frontend decides what "last 7 days" means
const now = new Date()                    // Client's local time!
const sevenDaysAgo = new Date(now)
sevenDaysAgo.setDate(now.getDate() - 7)  // Based on LOCAL timezone!

// Sends ISO strings that may not match server expectations
GET /api/v1/ventas/summary?from=2025-10-21T14:30:00.000Z&to=2025-10-27T14:30:00.000Z
```

**Why this is problematic:**
1. ❌ **Client time can be wrong** - User's device clock is not synchronized with server
2. ❌ **Timezone confusion** - Client uses local timezone, server uses CR timezone
3. ❌ **Inconsistent period boundaries** - Same query at different times gives different results
4. ❌ **Manipulable** - User can deliberately set device time to see unauthorized data
5. ❌ **Not idempotent** - Same request run at different times returns different data

---

## The Solution: Backend is the Authority

**The backend is the ONLY source of truth for date calculations.**

Frontend must:
- ✅ Send **semantic tokens only** (`today`, `yesterday`, `week`, `month`, `year`)
- ✅ For custom ranges, send **YYYY-MM-DD dates** (not timestamps)
- ✅ Let backend resolve tokens using CR timezone
- ✅ Always receive ISO 8601 UTC responses

---

## Frontend Implementation Guide

### Step 1: Remove All Date Range Calculations

**BEFORE (❌ WRONG):**
```typescript
// app/admin/index.tsx
const sevenDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000)  // ❌ Client calc
const now = new Date()                                                 // ❌ Client time

const { data: series7d } = useVentasTimeseries({
  date: 'range',
  from: sevenDaysAgo.toISOString(),  // ❌ ISO string with timezone confusion
  to: now.toISOString(),
  granularity: 'day',
})
```

**AFTER (✅ CORRECT):**
```typescript
// app/admin/index.tsx
const { data: series7d } = useVentasTimeseries({
  date: 'week',  // ✅ Let backend decide what "this week" means
  granularity: 'day',
})
```

---

### Step 2: Update All Date Token Usage

Replace all client-side range calculations with semantic tokens:

#### For Dashboard Comparisons

**BEFORE (❌):**
```typescript
// Current: last 7 days (calculated on client)
const current = {
  date: 'range',
  from: (now - 6d).toISOString(),
  to: now.toISOString()
}

// Previous: 7 days before that
const previous = {
  date: 'range',
  from: (now - 13d).toISOString(),
  to: (now - 7d).toISOString()
}
```

**AFTER (✅):**
```typescript
// Current: this week (backend decides)
const current = {
  date: 'week'
}

// Previous: same period last year (requires special handling)
// Option 1: Use 'week' for same period (may not align with business needs)
// Option 2: Send YYYY-MM-DD range if comparing exact last 7 days:
//   But ONLY for manual custom selections, not automatic comparisons
```

---

### Step 3: Custom Date Range Selection (When Needed)

If user selects a custom date range (e.g., via date picker):

```typescript
// User selects: 2025-10-01 to 2025-10-27
const customRange = {
  date: 'range',
  fromDate: '2025-10-01',    // ✅ YYYY-MM-DD (interpreted as 00:00:00 CR)
  toDate: '2025-10-27',      // ✅ YYYY-MM-DD (interpreted as 23:59:59 CR)
}

const { data } = useVentasSummary(customRange)
```

**Important:**
- Use `YYYY-MM-DD` format (NOT ISO 8601 timestamps)
- Backend interprets these as CR timezone dates
- No need to worry about timezone conversion

---

### Step 4: Update Hook Signatures

Update `hooks/useVentas.ts` to reflect the new parameter strategy:

```typescript
// BEFORE (❌)
export type VentasListQuery = {
  date?: 'today' | 'yesterday' | 'range'
  from?: string           // ISO string - WRONG!
  to?: string            // ISO string - WRONG!
}

// AFTER (✅)
export type VentasListQuery = {
  date?: 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'range'
  fromDate?: string       // YYYY-MM-DD format
  toDate?: string         // YYYY-MM-DD format
}
```

---

### Step 5: Update API Parameter Building

In `lib/api.client.ts`, ensure `fromDate`/`toDate` are sent as-is (no transformation):

```typescript
// buildQuery() should pass through YYYY-MM-DD dates unchanged
function buildQuery(params?: Record<string, any>) {
  const qp = new URLSearchParams()

  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    if (typeof v === 'string' && v.trim() === '') continue

    // ✅ Pass dates through as-is (YYYY-MM-DD)
    qp.set(k, String(v))
  }

  return qp.toString() ? `?${qp.toString()}` : ''
}
```

---

## Complete Examples

### Example 1: Today's Sales Summary

```typescript
// Frontend
const { data } = useVentasSummary({
  date: 'today'
})

// Generated request
GET /api/v1/ventas/summary?date=today

// Backend calculation (CR timezone)
fromAt: 2025-10-27T06:00:00.000Z  (2025-10-27 00:00:00 CR)
toAt:   2025-10-28T05:59:59.999Z  (2025-10-27 23:59:59 CR)
```

### Example 2: This Week's Trend

```typescript
// Frontend
const { data } = useVentasTimeseries({
  date: 'week',
  granularity: 'day'
})

// Generated request
GET /api/v1/ventas/timeseries?date=week&granularity=day

// Backend calculation (assuming today is Monday 2025-10-27)
fromAt: 2025-10-27T06:00:00.000Z  (Monday 00:00:00 CR)
toAt:   2025-11-03T05:59:59.999Z  (Sunday 23:59:59 CR)
```

### Example 3: Custom Manual Range

```typescript
// User picks Oct 1 to Oct 27 in a date picker
const { data } = useVentasSummary({
  date: 'range',
  fromDate: '2025-10-01',  // ✅ YYYY-MM-DD, not ISO
  toDate: '2025-10-27'     // ✅ YYYY-MM-DD, not ISO
})

// Generated request
GET /api/v1/ventas/summary?date=range&fromDate=2025-10-01&toDate=2025-10-27

// Backend calculation
fromAt: 2025-10-01T06:00:00.000Z  (Oct 1, 00:00:00 CR)
toAt:   2025-10-28T05:59:59.999Z  (Oct 27, 23:59:59 CR)
```

### Example 4: Dashboard - This Month vs Previous Month

```typescript
// Current month metrics
const { data: current } = useDashboard({
  date: 'month'
})

// For "previous period" comparison:
// Option 1: Use 'yesterday' for simple prev day comparison
const { data: previous } = useDashboard({
  date: 'yesterday'
})

// Option 2: If you need last month, use custom range
// (You'll need to calculate the dates in frontend, but send as YYYY-MM-DD)
const now = new Date()
const firstDayThisMonth = new Date(now.getFullYear(), now.getMonth(), 1)
const lastDayLastMonth = new Date(firstDayThisMonth.getTime() - 1)
const firstDayLastMonth = new Date(lastDayLastMonth.getFullYear(), lastDayLastMonth.getMonth(), 1)

const { data: previousMonth } = useDashboard({
  date: 'range',
  fromDate: formatAsYYYYMMDD(firstDayLastMonth),
  toDate: formatAsYYYYMMDD(lastDayLastMonth)
})
```

---

## Migration Checklist

### Files to Update

- [ ] `app/admin/index.tsx` - Remove `now`/`sevenDaysAgo`/etc. calculations
- [ ] `app/admin/dashboard.tsx` - Update date token usage
- [ ] `app/ventana/ventas/index.tsx` - Update date parameters
- [ ] `hooks/useVentas.ts` - Update type definitions (from/to → fromDate/toDate)
- [ ] `lib/api.ventas.ts` - Update parameter passing
- [ ] `lib/dateFormat.ts` - Remove client-side range calculation functions
- [ ] `store/ui.store.ts` - Update how `compareRange` is handled

### For Each Component

1. **Find**: All places calling `useVentas*()` hooks with date parameters
2. **Replace**: Client-calculated ISO strings with semantic tokens or YYYY-MM-DD ranges
3. **Test**: Verify all date ranges are correct in backend logs
4. **Verify**: Check that frontend no longer makes client-side calculations

### Date Token Decision Tree

```
User wants data for:
├─ Today? → date=today
├─ Yesterday? → date=yesterday
├─ This week? → date=week
├─ This month? → date=month
├─ This year? → date=year
└─ Custom date range?
   └─ Send: date=range&fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD
```

---

## Error Handling

If frontend sends invalid parameters, backend responds with 400:

```json
{
  "success": false,
  "error": {
    "message": "Invalid date parameter",
    "code": "SLS_2001",
    "details": [
      {
        "field": "date",
        "reason": "Must be one of: today, yesterday, week, month, year, range"
      }
    ]
  }
}
```

**Frontend should handle:**
- Catching 400 errors with code `SLS_2001`
- Showing user message: "Invalid date selection, please try again"
- Logging the error for debugging

---

## Timezone Awareness

**Frontend must NOT do timezone conversions.**

- ✅ Send dates as-is (YYYY-MM-DD)
- ✅ Backend handles CR timezone conversion
- ✅ Receive responses as ISO 8601 UTC
- ❌ Don't use `moment.tz`, `date-fns/tz`, etc. for API calls
- ❌ Don't add timezone offsets to timestamps

---

## Security Implications

This change improves security by:

1. **Eliminating client-side date calculations** - Can't be manipulated
2. **Using server time** - All dates anchored to server clock
3. **Immutable business logic** - Token meanings defined entirely on backend
4. **Audit trail** - Server logs show exact semantic token used
5. **Time skew resistance** - Client time doesn't matter, only server time

---

## Backward Compatibility

⚠️ **BREAKING CHANGE**

Once this is deployed:
- Old requests with ISO `from`/`to` parameters will fail
- Frontend MUST update all API calls
- No fallback period - update immediately

---

## Testing

### Test Case 1: Verify Token Consistency

```
Request 1: GET /api/v1/ventas/summary?date=today (at 2025-10-27 02:00 UTC)
Request 2: GET /api/v1/ventas/summary?date=today (at 2025-10-27 23:00 UTC)

Both should return data for same date (2025-10-27 in CR)
Even though server clock moved forward, same data
```

### Test Case 2: Verify YYYY-MM-DD Format

```
Request: GET /api/v1/ventas/summary?date=range&fromDate=2025-10-01&toDate=2025-10-27

Expected: Includes all transactions from 2025-10-01 00:00:00 CR to 2025-10-27 23:59:59 CR
Should NOT fail with timezone errors
```

### Test Case 3: Verify Week Calculation

```
Current date: 2025-10-27 (Monday in CR)
Request: GET /api/v1/ventas/summary?date=week

Expected: Returns data for 2025-10-27 (Mon) to 2025-11-02 (Sun) CR timezone
```

---

## Contact & Questions

If you have questions about these changes:
1. Review the backend calculation logic in `src/utils/dateRange.ts`
2. Check the test cases in test logs
3. Refer to `docs/DATE_PARAMETERS_STANDARDIZATION.md` for full API details

---

## Appendix: Helper Function for Date Formatting

If you need to format dates from a JavaScript Date to YYYY-MM-DD in CR timezone:

```typescript
function formatAsYYYYMMDD(date: Date): string {
  const formatter = new Intl.DateTimeFormat('es-CR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'America/Costa_Rica',
  })

  const parts = formatter.formatToParts(date)
  const year = parts.find(p => p.type === 'year')?.value
  const month = parts.find(p => p.type === 'month')?.value
  const day = parts.find(p => p.type === 'day')?.value

  return `${year}-${month}-${day}`
}

// Usage:
const today = formatAsYYYYMMDD(new Date())  // "2025-10-27"
```

