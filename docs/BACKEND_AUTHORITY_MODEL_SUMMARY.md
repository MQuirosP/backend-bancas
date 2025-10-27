# Backend Authority Model - Executive Summary

**Date**: 2025-10-27
**Status**: ✅ IMPLEMENTED & DOCUMENTED
**Action Required**: Frontend team must update immediately

---

## The Problem You Found

When you sent `?date=week` to the backend, you got a 400 error. This exposed a deeper issue:

```
GET /api/v1/ventas?page=1&pageSize=20&date=week&scope=mine
→ 400 Error: "Invalid option: expected 'today'|'yesterday'|'range'"
```

**Root Cause**: The backend had **3 different date parameter patterns** across different modules:
- Venta module: `date=today|yesterday|range` (didn't support `week`)
- Dashboard: `timeframe=thisWeek|thisMonth` (completely different!)
- Ticket: ISO datetime strings (totally separate)

**Plus a bigger issue**: The frontend was calculating dates on the **client side**, which is a security and consistency problem.

---

## What We Fixed

### ✅ Backend Changes (Complete)

1. **Extended date range utility** (`src/utils/dateRange.ts`)
   - Now supports: `today`, `yesterday`, `week`, `month`, `year`, `range`
   - All dates resolved server-side using CR timezone (UTC-6)
   - Fixed end-of-day calculation (was excluding last hour of the day)

2. **Standardized all endpoints** to use same pattern:
   ```
   GET /endpoint?date={token}&fromDate={optional}&toDate={optional}
   ```

3. **Updated Dashboard controller** to use `date` instead of `timeframe`

4. **Documentation created**:
   - `docs/DATE_PARAMETERS_STANDARDIZATION.md` - Technical details
   - `docs/FRONTEND_DATE_STRATEGY.md` - Complete frontend migration guide
   - `docs/BACKEND_AUTHORITY_MODEL_SUMMARY.md` - This document

### ⚠️ Frontend Changes (Still Needed)

**CURRENT PROBLEM**: Frontend is calculating date ranges on the client:
```javascript
// ❌ WRONG: Frontend does this
const now = new Date()                    // Client's local time!
const sevenDaysAgo = new Date(now)
sevenDaysAgo.setDate(now.getDate() - 7)  // Client-side math!
fetch(`/api/data?from=${sevenDaysAgo.toISOString()}&to=${now.toISOString()}`)
```

**CORRECT APPROACH**: Backend calculates everything:
```javascript
// ✅ CORRECT: Frontend just sends tokens
fetch(`/api/data?date=week`)  // Backend decides what "week" means
```

---

## Why This Matters

### Security Risk of Client-Side Calculation
1. User can manipulate device clock → sees unauthorized data
2. Client time may not match server time → inconsistent results
3. No audit trail → can't verify when data was requested

### Benefits of Backend Authority
1. ✅ **Immutable** - Same token always returns same data
2. ✅ **Secure** - Can't be manipulated by changing device time
3. ✅ **Consistent** - Server time is source of truth
4. ✅ **Auditable** - Exact token logged for every request

---

## What Frontend Must Do

### Immediate Actions

1. **Stop calculating date ranges on client**
   - Remove all `new Date()` calculations for API calls
   - Remove all `.setDate()`, `.setMonth()` math for API calls

2. **Send only semantic tokens**
   ```
   date=today        // Current day in CR
   date=yesterday    // Previous day
   date=week         // This week (Mon-Sun)
   date=month        // This month (1st-last day)
   date=year         // This year (Jan 1-Dec 31)
   ```

3. **For custom ranges, send YYYY-MM-DD**
   ```
   date=range&fromDate=2025-10-01&toDate=2025-10-27
   // NOT: 2025-10-01T00:00:00Z (timestamp)
   // YES: 2025-10-01 (date only)
   ```

### Files to Update in Frontend

See `docs/FRONTEND_DATE_STRATEGY.md` for details, but update:
- `app/admin/index.tsx` - Remove date calculations
- `app/admin/dashboard.tsx` - Update token usage
- `app/ventana/ventas/index.tsx` - Update queries
- `hooks/useVentas.ts` - Update type signatures
- `lib/api.ventas.ts` - Update parameter passing
- `store/ui.store.ts` - Update date range handling

---

## Examples: Before vs After

### Example 1: Today's Sales

**BEFORE** (❌ Problematic):
```javascript
const now = new Date()  // Client time
fetch(`/api/v1/ventas?from=${now.toISOString()}&to=${now.toISOString()}`)
```

**AFTER** (✅ Correct):
```javascript
fetch(`/api/v1/ventas?date=today`)
```

### Example 2: This Week's Trend

**BEFORE** (❌ Problematic):
```javascript
const now = new Date()
const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)  // Client calc!
fetch(`/api/v1/ventas/timeseries?from=${weekAgo.toISOString()}&to=${now.toISOString()}`)
```

**AFTER** (✅ Correct):
```javascript
fetch(`/api/v1/ventas/timeseries?date=week`)
```

### Example 3: Custom Range (Oct 1-27)

**BEFORE** (❌ Problematic):
```javascript
const from = new Date('2025-10-01')
const to = new Date('2025-10-27')
// Risk: local timezone interpretation is wrong!
fetch(`/api/data?from=${from.toISOString()}&to=${to.toISOString()}`)
```

**AFTER** (✅ Correct):
```javascript
// Just send dates, backend handles timezone
fetch(`/api/data?date=range&fromDate=2025-10-01&toDate=2025-10-27`)
```

---

## Testing Checklist

After frontend updates, verify:

- [ ] `GET /api/v1/ventas?date=today` returns today's data
- [ ] `GET /api/v1/ventas?date=yesterday` returns yesterday's data
- [ ] `GET /api/v1/ventas?date=week` returns Monday-Sunday data
- [ ] `GET /api/v1/ventas?date=month` returns full month
- [ ] `GET /api/v1/ventas?date=year` returns full year
- [ ] `GET /api/v1/ventas?date=range&fromDate=2025-10-01&toDate=2025-10-27` works
- [ ] Same request at different times returns same data (idempotency check)
- [ ] Invalid token like `?date=thisWeek` returns 400 error
- [ ] Logs show correct dateRange with `fromAt` and `toAt` in UTC

---

## How Date Resolution Works (FYI)

When frontend sends `?date=week`, backend does this:

```
Current time (server): 2025-10-28 05:00:00 UTC
Current date in CR:    2025-10-27 (00:00 to 23:59)

If Oct 27 is a Monday:
→ weekStart = Oct 27 (Monday)
→ weekEnd = Nov 02 (Sunday)

Returns:
  fromAt: 2025-10-27T06:00:00.000Z  (Oct 27 00:00 CR)
  toAt:   2025-11-03T05:59:59.999Z  (Nov 2 23:59:59 CR)
```

The key point: **backend uses server time, not client time**.

---

## Documentation Links

- **Technical Details**: `docs/DATE_PARAMETERS_STANDARDIZATION.md`
- **Frontend Migration Guide**: `docs/FRONTEND_DATE_STRATEGY.md`
- **Date Range Utility**: `src/utils/dateRange.ts`
- **Dashboard Controller**: `src/api/v1/controllers/dashboard.controller.ts`

---

## Next Steps

1. **Frontend Team**: Read `docs/FRONTEND_DATE_STRATEGY.md` immediately
2. **Frontend Team**: Update all API calls per migration guide
3. **QA Team**: Test all date parameter combinations
4. **Backend**: Monitor logs for date-related issues
5. **Ops**: Ensure server time is synchronized (NTP)

---

## Key Takeaway

**Backend is the authority for dates. Frontend just sends tokens.**

This ensures:
- ✅ Security (no client-side manipulation)
- ✅ Consistency (same token, same data)
- ✅ Reliability (server time is truth)
- ✅ Auditability (token logged for every request)

Stop doing date math in the frontend. Let the backend handle it.

---

**Questions?** Check `docs/FRONTEND_DATE_STRATEGY.md` or review the implementation in `src/utils/dateRange.ts`.

