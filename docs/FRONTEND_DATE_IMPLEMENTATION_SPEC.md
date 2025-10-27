# Frontend Date Implementation Specification

**Status**: ✅ BACKEND COMPLETE | ⏳ FRONTEND READY TO IMPLEMENT
**Date**: 2025-10-27
**Version**: 1.0
**Priority**: CRITICAL - Must implement before deploying dashboard

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Parameter Format](#parameter-format)
3. [Implementation Rules](#implementation-rules)
4. [Code Examples](#code-examples)
5. [Testing Checklist](#testing-checklist)
6. [Error Handling](#error-handling)
7. [Migration Path](#migration-path)

---

## Quick Start

### The Change

**OLD WAY** (❌ Currently broken):
```javascript
const now = new Date()
const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000)
fetch(`/api/v1/ventas?from=${weekAgo.toISOString()}&to=${now.toISOString()}`)
// → 400 error, parameter validation fails
```

**NEW WAY** (✅ Now required):
```javascript
fetch(`/api/v1/ventas?date=week`)
// → 200 success, backend calculates everything
```

### What Happens

```
Frontend sends: ?date=week
         ↓
Backend receives 'week' token
         ↓
Backend calculates:
  - Monday of current week in CR timezone (UTC-6)
  - Sunday of current week
  - Converts to UTC for database query
         ↓
Frontend receives data for exact 7-day period
```

---

## Parameter Format

### Universal Pattern (ALL Endpoints)

Every endpoint that filters by date accepts:

```
GET /endpoint?date={TOKEN}&fromDate={DATE}&toDate={DATE}
```

### Parameter Details

#### date (Query Parameter)

| Property | Value |
|----------|-------|
| **Name** | `date` |
| **Type** | String enum |
| **Default** | `"today"` |
| **Valid Values** | `"today"` \| `"yesterday"` \| `"week"` \| `"month"` \| `"year"` \| `"range"` |
| **Required** | No (defaults to "today" if omitted) |
| **Example** | `?date=week` |

#### fromDate (Query Parameter - Only when date=range)

| Property | Value |
|----------|-------|
| **Name** | `fromDate` |
| **Type** | String |
| **Format** | `YYYY-MM-DD` (exactly) |
| **Validation** | Regex: `/^\d{4}-\d{2}-\d{2}$/` |
| **Required** | Only if `date=range` |
| **Example** | `&fromDate=2025-10-01` |
| **Interpretation** | 00:00:00 in CR timezone (UTC-6) |

#### toDate (Query Parameter - Only when date=range)

| Property | Value |
|----------|-------|
| **Name** | `toDate` |
| **Type** | String |
| **Format** | `YYYY-MM-DD` (exactly) |
| **Validation** | Regex: `/^\d{4}-\d{2}-\d{2}$/` |
| **Required** | Only if `date=range` |
| **Example** | `&toDate=2025-10-27` |
| **Interpretation** | 23:59:59 in CR timezone (UTC-6) |

---

## Implementation Rules

### Rule 1: How to Format Dates

When you have a JavaScript Date object:

```javascript
// Function to format Date as YYYY-MM-DD
function formatDateAsYYYYMMDD(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// Usage
const today = new Date()
const formatted = formatDateAsYYYYMMDD(today)  // "2025-10-27"
```

### Rule 2: Never Add/Subtract Days on Frontend

❌ **WRONG**:
```javascript
const today = new Date()
const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
const from = formatDateAsYYYYMMDD(weekAgo)
const to = formatDateAsYYYYMMDD(today)
fetch(`/api/v1/ventas?date=range&fromDate=${from}&toDate=${to}`)
```

✅ **RIGHT**:
```javascript
fetch(`/api/v1/ventas?date=week`)
```

**Why**: Backend is authority. Server time is truth. Client time can be wrong.

### Rule 3: Use Semantic Tokens First

When user selects "This Week" → Use `?date=week`
When user selects "This Month" → Use `?date=month`
When user selects "This Year" → Use `?date=year`
When user selects custom dates → Use `?date=range&fromDate=...&toDate=...`

### Rule 4: Timezone Handling

**Frontend responsibility**: NONE. Don't do anything.

**What NOT to do**:
```javascript
// ❌ DON'T try to convert to CR timezone
const crOffset = -6 * 60  // UTC-6
const crDate = new Date(date.getTime() + crOffset * 60 * 1000)
fetch(`/api/v1/ventas?date=range&fromDate=${formatYYYYMMDD(crDate)}&toDate=...`)
```

**What TO do**:
```javascript
// ✅ Just send the date as-is (backend handles timezone)
const userSelectedDate = new Date(2025, 9, 1)  // Oct 1, any timezone
fetch(`/api/v1/ventas?date=range&fromDate=${formatYYYYMMDD(userSelectedDate)}&toDate=...`)
// Backend: "2025-10-01" → 2025-10-01 00:00:00 CR (UTC-6)
```

### Rule 5: Date Picker Integration

If using a date picker library (DatePicker, react-dates, etc.):

```javascript
import DatePicker from 'react-datepicker'

function DateRangeFilter() {
  const [fromDate, setFromDate] = useState(null)
  const [toDate, setToDate] = useState(null)

  const handleFetch = () => {
    const from = formatDateAsYYYYMMDD(fromDate)
    const to = formatDateAsYYYYMMDD(toDate)
    // Don't calculate days - let backend handle it
    fetch(`/api/v1/ventas?date=range&fromDate=${from}&toDate=${to}`)
  }

  return (
    <>
      <DatePicker value={fromDate} onChange={setFromDate} />
      <DatePicker value={toDate} onChange={setToDate} />
      <button onClick={handleFetch}>Fetch</button>
    </>
  )
}
```

---

## Code Examples

### Example 1: Fetch Today's Sales

```javascript
async function getTodaysSales() {
  const response = await fetch('/api/v1/ventas?date=today')
  const data = await response.json()
  return data
}
```

**What frontend sends**: `?date=today`
**What backend does**: Calculates full day (00:00-23:59 CR)
**Result**: Sales for today only

---

### Example 2: Fetch This Week's Dashboard

```javascript
async function getWeeksDashboard() {
  const response = await fetch('/api/v1/admin/dashboard?date=week')
  const data = await response.json()
  return data
}
```

**What frontend sends**: `?date=week`
**What backend does**: Calculates Monday-Sunday in CR
**Result**: Dashboard metrics for 7-day period

---

### Example 3: Fetch Custom Date Range

```javascript
async function getVentasByRange(fromDate, toDate) {
  // fromDate and toDate are JavaScript Date objects
  const from = formatDateAsYYYYMMDD(fromDate)
  const to = formatDateAsYYYYMMDD(toDate)

  const url = new URL('/api/v1/ventas', window.location.origin)
  url.searchParams.set('date', 'range')
  url.searchParams.set('fromDate', from)
  url.searchParams.set('toDate', to)

  const response = await fetch(url.toString())
  const data = await response.json()
  return data
}

// Usage (user selected Oct 1 to Oct 27)
const from = new Date(2025, 9, 1)
const to = new Date(2025, 9, 27)
getVentasByRange(from, to)
// Sends: ?date=range&fromDate=2025-10-01&toDate=2025-10-27
```

---

### Example 4: Dashboard with Date Selector

```javascript
import { useState } from 'react'

function DashboardPage() {
  const [selectedPeriod, setSelectedPeriod] = useState('today')
  const [dashboardData, setDashboardData] = useState(null)

  async function fetchDashboard(period) {
    const response = await fetch(
      `/api/v1/admin/dashboard?date=${period}`
    )
    const data = await response.json()
    setDashboardData(data)
  }

  return (
    <div>
      <div className="period-selector">
        <button onClick={() => {
          setSelectedPeriod('today')
          fetchDashboard('today')
        }}>
          Today
        </button>
        <button onClick={() => {
          setSelectedPeriod('week')
          fetchDashboard('week')
        }}>
          This Week
        </button>
        <button onClick={() => {
          setSelectedPeriod('month')
          fetchDashboard('month')
        }}>
          This Month
        </button>
        <button onClick={() => {
          setSelectedPeriod('year')
          fetchDashboard('year')
        }}>
          This Year
        </button>
      </div>

      {dashboardData && (
        <div className="dashboard">
          <KPICard label="Ganancia" value={dashboardData.ganancia} />
          <KPICard label="CxC" value={dashboardData.cxc} />
          <KPICard label="CxP" value={dashboardData.cxp} />
        </div>
      )}
    </div>
  )
}

export default DashboardPage
```

---

### Example 5: React Hook for Date Filtering

```javascript
import { useQuery } from '@tanstack/react-query'

function useDateFilteredData(endpoint, dateToken) {
  return useQuery({
    queryKey: [endpoint, 'date', dateToken],
    queryFn: async () => {
      const response = await fetch(`/api/v1${endpoint}?date=${dateToken}`)
      if (!response.ok) throw new Error('Failed to fetch')
      return response.json()
    },
    staleTime: 60 * 1000,  // 1 minute cache
  })
}

// Usage
function VentasReport() {
  const { data, isLoading, error } = useDateFilteredData('/ventas', 'week')

  if (isLoading) return <div>Loading...</div>
  if (error) return <div>Error: {error.message}</div>

  return <VentasTable data={data} />
}
```

---

### Example 6: Building Query Strings Correctly

```javascript
// Helper to build query string safely
function buildDateQuery(endpoint, params) {
  const url = new URL(`/api/v1${endpoint}`, window.location.origin)

  // Set date parameter
  url.searchParams.set('date', params.date)  // e.g., 'week'

  // If custom range, add dates
  if (params.date === 'range') {
    if (!params.fromDate) throw new Error('fromDate required for range')
    if (!params.toDate) throw new Error('toDate required for range')

    url.searchParams.set('fromDate', params.fromDate)  // YYYY-MM-DD
    url.searchParams.set('toDate', params.toDate)      // YYYY-MM-DD
  }

  // Add any other filters
  if (params.status) url.searchParams.set('status', params.status)
  if (params.page) url.searchParams.set('page', params.page)

  return url.toString()
}

// Usage
const query = buildDateQuery('/ventas', {
  date: 'range',
  fromDate: '2025-10-01',
  toDate: '2025-10-27',
  status: 'ACTIVE',
  page: 1
})

const response = await fetch(query)
```

---

## Testing Checklist

### Before Submitting for QA

- [ ] All API calls use `?date={token}` pattern
- [ ] No client-side date calculations (no subtracting days)
- [ ] Custom range dates formatted as YYYY-MM-DD
- [ ] Never send ISO datetime strings (`2025-10-27T00:00:00Z`)
- [ ] All 6 date tokens tested: today, yesterday, week, month, year, range
- [ ] Custom date picker integration works
- [ ] Error messages displayed when validation fails
- [ ] Timezone-agnostic (test on different system clocks if possible)
- [ ] No TypeScript errors
- [ ] Network tab shows correct query parameters
- [ ] Response includes `meta.range` with dateRange info

### Manual Test Cases

1. **Test Today Token**
   ```javascript
   fetch('/api/v1/ventas?date=today')
   // Verify: Shows only today's data
   ```

2. **Test Week Token**
   ```javascript
   fetch('/api/v1/admin/dashboard?date=week')
   // Verify: Shows Monday-Sunday data
   ```

3. **Test Custom Range**
   ```javascript
   fetch('/api/v1/ventas?date=range&fromDate=2025-10-01&toDate=2025-10-27')
   // Verify: Shows exactly Oct 1-27 data
   ```

4. **Test Invalid Token**
   ```javascript
   fetch('/api/v1/ventas?date=thisWeek')
   // Verify: 400 error with message listing valid tokens
   ```

5. **Test Invalid Date Format**
   ```javascript
   fetch('/api/v1/ventas?date=range&fromDate=10/01/2025&toDate=2025-10-27')
   // Verify: 400 error mentioning YYYY-MM-DD format
   ```

---

## Error Handling

### Handle 400 Validation Errors

```javascript
async function fetchWithErrorHandling(endpoint, dateParams) {
  try {
    const response = await fetch(`/api/v1${endpoint}?${dateParams}`)

    if (!response.ok) {
      const error = await response.json()

      if (error.error?.code === 'SLS_2001') {
        // Date validation error
        console.error('Invalid date parameter:', error.error.details)
        // Show user-friendly message
        alert('Invalid date selection. Please try again.')
        return null
      }

      throw new Error(`HTTP ${response.status}`)
    }

    return await response.json()
  } catch (err) {
    console.error('Request failed:', err)
    alert('Failed to fetch data. Please try again.')
    return null
  }
}
```

### Display Error Messages

```javascript
function DateSelector({ onError }) {
  const [errorMsg, setErrorMsg] = useState(null)

  async function handleDateChange(token) {
    const data = await fetchWithErrorHandling('/ventas', `date=${token}`)

    if (!data) {
      setErrorMsg('Failed to load data for selected period')
      onError?.()
    } else {
      setErrorMsg(null)
      // Update UI with data
    }
  }

  return (
    <div>
      <select onChange={(e) => handleDateChange(e.target.value)}>
        <option value="today">Today</option>
        <option value="week">This Week</option>
        <option value="month">This Month</option>
        <option value="year">This Year</option>
      </select>

      {errorMsg && <div className="error">{errorMsg}</div>}
    </div>
  )
}
```

---

## Migration Path

### Step 1: Update API Calls (CRITICAL)

Find all places calling:
- `/ventas?from=...&to=...` → Change to `?date=range&fromDate=...&toDate=...`
- `/ventas/summary?from=...&to=...` → Same change
- `/admin/dashboard?timeframe=...` → Change to `?date=...`

Files to check:
- `lib/api.ventas.ts` - Update API client methods
- `hooks/useVentas.ts` - Update query parameter types
- `app/admin/index.tsx` - Update Dashboard queries
- `app/admin/dashboard.tsx` - Update date parameters
- `app/ventana/ventas/index.tsx` - Update Ventana queries

### Step 2: Remove Date Calculations

Remove all code like:
```javascript
// DELETE THIS:
const now = new Date()
const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000)
const weekAgo = new Date(now - 6 * 24 * 60 * 60 * 1000)
y.setDate(y.getDate() - 1)
prevTo = new Date(now)
prevTo.setDate(now.getDate() - 7)
```

Replace with:
```javascript
// USE THIS:
fetch(`/api/v1/ventas?date=week`)
fetch(`/api/v1/ventas?date=month`)
fetch(`/api/v1/admin/dashboard?date=range&fromDate=2025-10-01&toDate=2025-10-27`)
```

### Step 3: Update Type Definitions

```typescript
// BEFORE (❌)
export type VentasListQuery = {
  from?: string      // ISO datetime
  to?: string        // ISO datetime
}

// AFTER (✅)
export type VentasListQuery = {
  date?: 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'range'
  fromDate?: string  // YYYY-MM-DD
  toDate?: string    // YYYY-MM-DD
}
```

### Step 4: Test All 6 Tokens

```javascript
// Test each token individually
const tokens = ['today', 'yesterday', 'week', 'month', 'year']

for (const token of tokens) {
  const response = await fetch(`/api/v1/ventas?date=${token}`)
  console.log(`Token: ${token}`, response.ok)
}

// Test custom range
const response = await fetch(`/api/v1/ventas?date=range&fromDate=2025-10-01&toDate=2025-10-27`)
console.log('Custom range:', response.ok)
```

---

## Utility Functions to Use

### formatDateAsYYYYMMDD

```typescript
export function formatDateAsYYYYMMDD(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
```

### buildDateQuery

```typescript
export function buildDateQuery(
  dateToken: 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'range',
  fromDate?: Date,
  toDate?: Date
): string {
  if (dateToken === 'range') {
    if (!fromDate || !toDate) {
      throw new Error('fromDate and toDate required for range')
    }
    return `date=range&fromDate=${formatDateAsYYYYMMDD(fromDate)}&toDate=${formatDateAsYYYYMMDD(toDate)}`
  }
  return `date=${dateToken}`
}
```

### useDateFilter Hook

```typescript
import { useQuery } from '@tanstack/react-query'

export function useDateFilter(
  endpoint: string,
  dateToken: string,
  fromDate?: Date,
  toDate?: Date
) {
  const queryParams = buildDateQuery(dateToken as any, fromDate, toDate)

  return useQuery({
    queryKey: [endpoint, dateToken, fromDate, toDate],
    queryFn: async () => {
      const response = await fetch(`/api/v1${endpoint}?${queryParams}`)
      if (!response.ok) throw new Error('Failed to fetch')
      return response.json()
    },
    staleTime: 60000,
  })
}

// Usage
const { data } = useDateFilter('/ventas', 'week')
const { data: rangeData } = useDateFilter('/ventas', 'range', new Date(2025,9,1), new Date(2025,9,27))
```

---

## Key Takeaways

1. **Backend is Authority** - Never calculate dates on frontend
2. **One Standard** - All endpoints use `date` + `fromDate`/`toDate`
3. **YYYY-MM-DD Only** - Exactly that format, no ISO datetime
4. **Six Tokens** - today, yesterday, week, month, year, range
5. **Zero Timezone Math** - Let backend handle it
6. **Type Safe** - Use TypeScript enums for date tokens

---

**Status**: ✅ SPECIFICATION COMPLETE & READY FOR IMPLEMENTATION

Frontend can begin implementation immediately. All parameters are finalized and tested on backend.

