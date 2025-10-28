# Frontend Sales (Ventas) API Integration Guide

**Module**: Lottery Sales Analytics
**Version**: 1.0
**Last Updated**: 2025-10-28
**Status**: Production Ready

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Authentication & Authorization](#authentication--authorization)
3. [API Endpoints Summary](#api-endpoints-summary)
4. [Detailed Endpoint Reference](#detailed-endpoint-reference)
5. [Query Parameters Guide](#query-parameters-guide)
6. [Date Handling](#date-handling)
7. [Error Handling](#error-handling)
8. [Code Examples](#code-examples)
9. [Common Patterns](#common-patterns)
10. [Testing Checklist](#testing-checklist)

---

## Quick Start

### Base URL
```
https://your-api-domain/api/v1/ventas
```

### Authentication
All requests require a JWT token in the Authorization header:
```
Authorization: Bearer <JWT_TOKEN>
```

### Minimal Request Example
```javascript
// Today's sales summary
fetch('https://api.example.com/api/v1/ventas/summary', {
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
})
.then(res => res.json())
.then(data => console.log(data))
```

---

## Authentication & Authorization

### Role-Based Access Control (RBAC)

The API enforces role-based filtering automatically:

#### VENDEDOR (Seller)
- **Auto-filtered to**: Own sales only (`vendedorId = your_id`)
- **Cannot override**: Cannot request other sellers' data
- **Visibility**: All endpoints work, but filtered to personal sales

#### VENTANA (Sales Window Manager)
- **Auto-filtered to**: Own window only (`ventanaId = your_window_id`)
- **Can request**: Sellers within their window via `vendedorId` param
- **Validation**: System validates seller belongs to window (403 error if not)
- **Visibility**: All endpoints, filtered to window scope

#### ADMIN
- **No filtering**: All parameters honored as-is
- **Visibility**: Cross-organizational data access

### What This Means For Frontend

**✓ DO THIS:**
```javascript
// VENDEDOR requesting breakdown - system auto-restricts to their sales
fetch('/api/v1/ventas/breakdown?dimension=loteria&date=week')

// VENTANA requesting specific seller's data
fetch('/api/v1/ventas/breakdown?dimension=vendedor&vendedorId=seller-uuid&date=month')
```

**✗ DON'T DO THIS:**
```javascript
// VENDEDOR trying to see another seller's data
fetch('/api/v1/ventas?vendedorId=OTHER_SELLER_UUID')
// → Returns 403 RBAC error

// VENTANA trying to see different window's data
fetch('/api/v1/ventas?ventanaId=DIFFERENT_WINDOW_UUID')
// → Returns 403 RBAC error
```

---

## API Endpoints Summary

| Endpoint | Method | Purpose | Required Params |
|----------|--------|---------|-----------------|
| `/ventas` | GET | Transactional detail (paginated) | None |
| `/ventas/summary` | GET | KPI executive summary | None |
| `/ventas/breakdown` | GET | Top-N analysis by dimension | `dimension` |
| `/ventas/timeseries` | GET | Time-bucketed aggregation | None |
| `/ventas/facets` | GET | Available filter values | None |

---

## Detailed Endpoint Reference

### 1. LIST - `/ventas`

**Retrieve paginated transaction details**

#### Purpose
Transaction-level view of all tickets with full details. Use for tables, detailed reports, exports.

#### HTTP
```
GET /ventas?page=1&pageSize=20&date=today
```

#### Query Parameters

| Param | Type | Default | Required | Max | Notes |
|-------|------|---------|----------|-----|-------|
| `page` | int | 1 | No | - | Min: 1 |
| `pageSize` | int | 20 | No | 100 | Min: 1, capped at 100 |
| `date` | enum | today | No | - | today\|yesterday\|week\|month\|year\|range |
| `fromDate` | string | - | Conditional | - | YYYY-MM-DD, required if date=range |
| `toDate` | string | - | Conditional | - | YYYY-MM-DD, required if date=range |
| `status` | enum | - | No | - | ACTIVE\|EVALUATED\|CANCELLED\|RESTORED |
| `winnersOnly` | bool | - | No | - | true/false |
| `bancaId` | uuid | - | No | - | Filter by banking house |
| `ventanaId` | uuid | - | No | - | (RBAC: auto-filtered for VENTANA/VENDEDOR) |
| `vendedorId` | uuid | - | No | - | (RBAC: auto-filtered for VENDEDOR) |
| `loteriaId` | uuid | - | No | - | Filter by lottery |
| `sorteoId` | uuid | - | No | - | Filter by draw |
| `search` | string | - | No | 100 | Full-text search |
| `orderBy` | string | - | No | - | createdAt, totalAmount, ticketNumber (prefix - for DESC) |

#### Response (200 OK)

```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "ticketNumber": "T250126-00000A-42",
      "totalAmount": 50000,
      "createdAt": "2025-10-27T10:30:45.123Z",
      "status": "ACTIVE",
      "isWinner": false,
      "ventana": {
        "id": "uuid",
        "name": "Ventana Paseo Colón",
        "code": "PC001"
      },
      "vendedor": {
        "id": "uuid",
        "name": "Juan Pérez",
        "username": "jperez"
      },
      "loteria": {
        "id": "uuid",
        "name": "Lotto 3D"
      },
      "sorteo": {
        "id": "uuid",
        "name": "Sorteo #125",
        "scheduledAt": "2025-10-27T14:00:00Z",
        "status": "EVALUATED"
      },
      "jugadas": [
        {
          "id": "uuid",
          "type": "DIRECTO",
          "number": "123",
          "amount": 25000,
          "finalMultiplierX": 500,
          "payout": 12500000,
          "isWinner": true
        }
      ]
    }
  ],
  "meta": {
    "total": 250,
    "page": 1,
    "pageSize": 20,
    "totalPages": 13,
    "hasNextPage": true,
    "hasPrevPage": false,
    "range": {
      "fromAt": "2025-10-27T06:00:00.000Z",
      "toAt": "2025-10-27T05:59:59.999Z",
      "tz": "America/Costa_Rica"
    },
    "effectiveFilters": {
      "date": "today"
    }
  }
}
```

#### Errors

| Code | Status | Meaning |
|------|--------|---------|
| SLS_2001 | 400 | Invalid date format or range |
| SLS_2002 | 400 | Invalid filter parameter |
| RBAC_001 | 403 | Access denied (cross-window) |

#### Example Requests

**Today's sales, page 1**
```
GET /ventas?page=1&pageSize=20
```

**Last 7 days, winners only**
```
GET /ventas?date=week&winnersOnly=true
```

**Custom date range with seller filter**
```
GET /ventas?date=range&fromDate=2025-10-01&toDate=2025-10-27&vendedorId=uuid-123
```

**Search for ticket number**
```
GET /ventas?search=T250126&pageSize=50
```

**Sorted by amount descending**
```
GET /ventas?orderBy=-totalAmount&pageSize=100
```

---

### 2. SUMMARY - `/ventas/summary`

**Get KPI executive overview**

#### Purpose
High-level metrics for dashboards, KPI cards, executive reports. Single aggregated record.

#### HTTP
```
GET /ventas/summary?date=today
```

#### Query Parameters

| Param | Type | Default | Required | Notes |
|-------|------|---------|----------|-------|
| `date` | enum | today | No | today\|yesterday\|week\|month\|year\|range |
| `fromDate` | string | - | Conditional | YYYY-MM-DD, required if date=range |
| `toDate` | string | - | Conditional | YYYY-MM-DD, required if date=range |
| `status` | enum | - | No | ACTIVE\|EVALUATED\|... |
| `winnersOnly` | bool | - | No | true/false |
| `ventanaId` | uuid | - | No | (RBAC: auto-filtered) |
| `vendedorId` | uuid | - | No | (RBAC: auto-filtered) |
| `loteriaId` | uuid | - | No | Filter by lottery |
| `sorteoId` | uuid | - | No | Filter by draw |

#### Response (200 OK)

```json
{
  "success": true,
  "data": {
    "ventasTotal": 1500000,
    "ticketsCount": 75,
    "jugadasCount": 450,
    "payoutTotal": 12500000,
    "neto": -11000000,
    "commissionTotal": 225000,
    "netoDespuesComision": -11225000,
    "lastTicketAt": "2025-10-27T16:45:30.123Z"
  },
  "meta": {
    "range": {
      "fromAt": "2025-10-27T06:00:00.000Z",
      "toAt": "2025-10-27T05:59:59.999Z",
      "tz": "America/Costa_Rica"
    },
    "effectiveFilters": {
      "date": "today"
    }
  }
}
```

#### Example Requests

**Today's metrics**
```
GET /ventas/summary
```

**This month's performance**
```
GET /ventas/summary?date=month
```

**Seller's week metrics**
```
GET /ventas/summary?vendedorId=uuid-123&date=week
```

---

### 3. BREAKDOWN - `/ventas/breakdown`

**Analyze sales by dimension (Top-N)**

#### Purpose
Dimensional analysis: Which sellers performed best? Which lotteries? Most played numbers?

#### HTTP
```
GET /ventas/breakdown?dimension=vendedor&top=10&date=today
```

#### Query Parameters

| Param | Type | Default | Required | Max | Notes |
|-------|------|---------|----------|-----|-------|
| `dimension` | enum | - | **YES** | - | ventana\|vendedor\|loteria\|sorteo\|numero |
| `top` | int | 10 | No | 50 | Min: 1, Max: 50 |
| `date` | enum | today | No | - | today\|yesterday\|week\|month\|year\|range |
| `fromDate` | string | - | Conditional | - | YYYY-MM-DD |
| `toDate` | string | - | Conditional | - | YYYY-MM-DD |
| `status` | enum | - | No | - | Filter by status |
| `winnersOnly` | bool | - | No | - | true/false |
| `ventanaId` | uuid | - | No | - | (RBAC: auto-filtered) |
| `vendedorId` | uuid | - | No | - | (RBAC: auto-filtered) |
| `loteriaId` | uuid | - | No | - | Filter by lottery |
| `sorteoId` | uuid | - | No | - | Filter by draw |

#### Response (200 OK)

```json
{
  "success": true,
  "data": [
    {
      "key": "uuid-or-number",
      "name": "Ventana Centro",
      "ventasTotal": 500000,
      "ticketsCount": 25,
      "payoutTotal": 5000000,
      "neto": -4500000,
      "commissionTotal": 75000,
      "totalWinningTickets": 5,
      "totalPaidTickets": 3
    },
    {
      "key": "uuid-or-number-2",
      "name": "Ventana Paseo",
      "ventasTotal": 450000,
      "ticketsCount": 22,
      "payoutTotal": 4500000,
      "neto": -4050000,
      "commissionTotal": 67500,
      "totalWinningTickets": 4,
      "totalPaidTickets": 2
    }
  ],
  "meta": {
    "range": {
      "fromAt": "2025-10-27T06:00:00.000Z",
      "toAt": "2025-10-27T05:59:59.999Z",
      "tz": "America/Costa_Rica"
    },
    "dimension": "ventana",
    "topCount": 10,
    "effectiveFilters": {
      "date": "today"
    }
  }
}
```

#### Dimension Behaviors

**ventana**: Group by sales window
- `key`: ventanaId (UUID)
- `name`: Window name
- Best for: Window performance comparison

**vendedor**: Group by seller
- `key`: userId (UUID)
- `name`: Seller name
- Best for: Seller rankings, performance leaderboards

**loteria**: Group by lottery
- `key`: loteriaId (UUID)
- `name`: Lottery name
- Best for: Lottery popularity, revenue by game

**sorteo**: Group by draw
- `key`: sorteoId (UUID)
- `name`: Draw name + scheduledAt
- Best for: Draw-specific analysis

**numero**: Group by number (0-999, etc.)
- `key`: The number string (e.g., "123")
- `name`: "Número 123"
- Best for: Most played numbers, hot numbers

#### Example Requests

**Top 10 sellers today**
```
GET /ventas/breakdown?dimension=vendedor&top=10
```

**Top 5 windows this month**
```
GET /ventas/breakdown?dimension=ventana&top=5&date=month
```

**Top 20 most played numbers**
```
GET /ventas/breakdown?dimension=numero&top=20&date=week
```

**Top lotteries with winners only**
```
GET /ventas/breakdown?dimension=loteria&winnersOnly=true
```

**Top 10 draws with custom date range**
```
GET /ventas/breakdown?dimension=sorteo&date=range&fromDate=2025-10-01&toDate=2025-10-27&top=10
```

---

### 4. TIMESERIES - `/ventas/timeseries`

**Time-bucketed sales aggregation**

#### Purpose
Charts and trend analysis: How do sales vary over time? Hourly spikes? Weekly patterns?

#### HTTP
```
GET /ventas/timeseries?granularity=day&date=week
```

#### Query Parameters

| Param | Type | Default | Required | Notes |
|-------|------|---------|----------|-------|
| `granularity` | enum | day | No | hour\|day\|week |
| `date` | enum | today | No | today\|yesterday\|week\|month\|year\|range |
| `fromDate` | string | - | Conditional | YYYY-MM-DD |
| `toDate` | string | - | Conditional | YYYY-MM-DD |
| `status` | enum | - | No | Filter by status |
| `winnersOnly` | bool | - | No | true/false |
| `ventanaId` | uuid | - | No | (RBAC: auto-filtered) |
| `vendedorId` | uuid | - | No | (RBAC: auto-filtered) |
| `loteriaId` | uuid | - | No | Filter by lottery |
| `sorteoId` | uuid | - | No | Filter by draw |

#### Range Limits

**IMPORTANT**: Each granularity has maximum date range:

| Granularity | Max Range | Use Case |
|-------------|-----------|----------|
| hour | 30 days | Detailed daily patterns |
| day | 90 days | Monthly trends |
| week | unlimited | Yearly trends |

Exceeding range → Error SLS_2001

#### Response (200 OK)

```json
{
  "success": true,
  "data": [
    {
      "ts": "2025-10-27T06:00:00.000Z",
      "ventasTotal": 150000,
      "ticketsCount": 15,
      "commissionTotal": 22500
    },
    {
      "ts": "2025-10-27T18:00:00.000Z",
      "ventasTotal": 200000,
      "ticketsCount": 20,
      "commissionTotal": 30000
    },
    {
      "ts": "2025-10-28T06:00:00.000Z",
      "ventasTotal": 175000,
      "ticketsCount": 17,
      "commissionTotal": 26250
    }
  ],
  "meta": {
    "range": {
      "fromAt": "2025-10-27T06:00:00.000Z",
      "toAt": "2025-10-28T05:59:59.999Z",
      "tz": "America/Costa_Rica"
    },
    "granularity": "day",
    "effectiveFilters": {
      "date": "week"
    }
  }
}
```

#### Example Requests

**Today's hourly breakdown**
```
GET /ventas/timeseries?granularity=hour
```

**Last 7 days by day**
```
GET /ventas/timeseries?granularity=day&date=week
```

**Last 30 days hourly (max for hour granularity)**
```
GET /ventas/timeseries?granularity=hour&date=range&fromDate=2025-09-28&toDate=2025-10-27
```

**This month by day**
```
GET /ventas/timeseries?granularity=day&date=month
```

**Entire year by week**
```
GET /ventas/timeseries?granularity=week&date=year
```

---

### 5. FACETS - `/ventas/facets`

**Discover available filter values**

#### Purpose
Populate filter dropdowns: Which windows exist? Which sellers are active today?

#### HTTP
```
GET /ventas/facets?date=today
```

#### Query Parameters

| Param | Type | Default | Required | Notes |
|-------|------|---------|----------|-------|
| `date` | enum | today | No | Scope facets to date range |
| `fromDate` | string | - | Conditional | YYYY-MM-DD |
| `toDate` | string | - | Conditional | YYYY-MM-DD |

#### Response (200 OK)

```json
{
  "success": true,
  "data": {
    "ventanas": [
      {
        "id": "uuid-1",
        "name": "Ventana Paseo Colón",
        "code": "PC001"
      },
      {
        "id": "uuid-2",
        "name": "Ventana San José",
        "code": "SJ001"
      }
    ],
    "vendedores": [
      {
        "id": "uuid-seller-1",
        "name": "Juan Pérez",
        "username": "jperez"
      },
      {
        "id": "uuid-seller-2",
        "name": "María González",
        "username": "mgonzalez"
      }
    ],
    "loterias": [
      {
        "id": "uuid-lot-1",
        "name": "Lotto 3D"
      },
      {
        "id": "uuid-lot-2",
        "name": "Loto Clásico"
      }
    ],
    "sorteos": [
      {
        "id": "uuid-sorteo-1",
        "name": "Sorteo #125",
        "scheduledAt": "2025-10-27T14:00:00Z"
      }
    ]
  },
  "meta": {
    "range": {
      "fromAt": "2025-10-27T06:00:00.000Z",
      "toAt": "2025-10-27T05:59:59.999Z",
      "tz": "America/Costa_Rica"
    },
    "effectiveFilters": {
      "date": "today"
    }
  }
}
```

#### Example Requests

**Available filters for today**
```
GET /ventas/facets
```

**Available filters for this month**
```
GET /ventas/facets?date=month
```

**Available filters for custom period**
```
GET /ventas/facets?date=range&fromDate=2025-10-01&toDate=2025-10-27
```

---

## Query Parameters Guide

### Date Parameters - CRITICAL

All endpoints support semantic date ranges. **Client sends calendar dates in CR timezone**, backend converts to UTC automatically.

#### Semantic Dates

```javascript
// Send these strings in ?date parameter
"today"      // Current day in Costa Rica (00:00 to 23:59 CR)
"yesterday"  // Previous day
"week"       // Current week (Monday to Sunday)
"month"      // Current month (1st to last day)
"year"       // Current year (Jan 1 to Dec 31)
"range"      // Custom range (requires fromDate & toDate)
```

#### Custom Ranges

When `date=range`, provide:

```javascript
// Example: Oct 1 to Oct 27, 2025
?date=range&fromDate=2025-10-01&toDate=2025-10-27

// Format: YYYY-MM-DD (calendar dates in Costa Rica timezone)
```

#### Timezone Behavior

- **Client sends**: Calendar dates (YYYY-MM-DD) in Costa Rica timezone
- **Backend interprets**: Each date as 00:00:00 to 23:59:59 in Costa Rica (UTC-6)
- **Database stores**: UTC times
- **Response includes**: `tz: "America/Costa_Rica"` confirmation

Example:
```
Client sends: fromDate=2025-10-27
Backend interprets: 2025-10-27 00:00:00 CR = 2025-10-27 06:00:00 UTC
Database query: WHERE createdAt >= 2025-10-27 06:00:00 UTC
```

### Filter Parameters

#### Simple Filters (UUID)
```
?ventanaId=uuid-123
?vendedorId=uuid-456
?loteriaId=uuid-789
?sorteoId=uuid-999
?bancaId=uuid-111
```

#### Boolean Filters
```
?winnersOnly=true    // Only winning tickets
```

#### Status Filter
```
?status=ACTIVE       // or EVALUATED, CANCELLED, RESTORED
```

#### Search Filter (List Only)
```
?search=T250126      // Ticket number partial match
?search=Juan         // Seller name match
?search=Lotto        // Lottery name match
```

Max 100 characters.

#### Sort Order (List Only)
```
?orderBy=createdAt        // Ascending
?orderBy=-createdAt       // Descending (prefix with -)
?orderBy=totalAmount      // Ascending by sales total
?orderBy=-totalAmount     // Descending by sales total
```

### Pagination (List Only)

```
?page=1              // Default: 1
?pageSize=20         // Default: 20, Max: 100
```

---

## Date Handling

### For Frontend Developers

#### DO: Send dates in Costa Rica calendar format
```javascript
const today = new Date();
const year = today.getFullYear();
const month = String(today.getMonth() + 1).padStart(2, '0');
const day = String(today.getDate()).padStart(2, '0');

const crDateString = `${year}-${month}-${day}`;
// Result: "2025-10-27"

// Use in API
fetch(`/api/v1/ventas/summary?date=range&fromDate=${crDateString}&toDate=${crDateString}`)
```

#### DON'T: Send ISO strings or timestamps
```javascript
// ❌ WRONG
?fromDate=2025-10-27T06:00:00Z
?fromDate=1730010000000

// ✓ CORRECT
?fromDate=2025-10-27
```

#### Helper Function
```javascript
function formatCRDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Usage
const today = formatCRDate();
const yesterday = formatCRDate(new Date(Date.now() - 86400000));
const lastMonth = formatCRDate(new Date(date.getFullYear(), date.getMonth() - 1, 1));

fetch(`/ventas?date=range&fromDate=${yesterday}&toDate=${today}`)
```

### Response Date Handling

All timestamps in responses are **ISO 8601 UTC**:
```json
{
  "createdAt": "2025-10-27T10:30:45.123Z",
  "ts": "2025-10-27T06:00:00.000Z",
  "meta": {
    "range": {
      "fromAt": "2025-10-27T06:00:00.000Z",  // UTC
      "toAt": "2025-10-28T05:59:59.999Z",    // UTC
      "tz": "America/Costa_Rica"             // Context: this was converted from CR time
    }
  }
}
```

**For Display**: Convert UTC to local/CR timezone before showing user:
```javascript
const createdAt = new Date("2025-10-27T10:30:45.123Z");
const crFormatter = new Intl.DateTimeFormat('es-CR', {
  timeZone: 'America/Costa_Rica',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});
console.log(crFormatter.format(createdAt));
// "27/10/2025, 04:30:45"
```

---

## Error Handling

### Standard Error Response
```json
{
  "success": false,
  "error": {
    "message": "Invalid date range",
    "code": "SLS_2001",
    "statusCode": 400,
    "details": [
      {
        "field": "toDate",
        "reason": "Cannot be in the future"
      }
    ]
  }
}
```

### Common Errors

#### SLS_2001 - Validation Error (400)
- Invalid date format (not YYYY-MM-DD)
- Date range issues (fromDate > toDate)
- Timeseries range exceeded (hour limit: 30 days)
- Invalid top value (> 50)

**Handle in Frontend:**
```javascript
const response = await fetch(url);
const data = await response.json();

if (!data.success) {
  if (data.error.code === 'SLS_2001') {
    // Show date picker error to user
    console.error(`Validation Error: ${data.error.details[0].reason}`);
  }
}
```

#### SLS_2002 - Invalid Parameter (400)
- Invalid dimension (not one of: ventana, vendedor, loteria, sorteo, numero)
- Missing required parameter
- Invalid granularity (not hour, day, or week)

#### RBAC_001 / RBAC_002 - Access Denied (403)
- VENTANA user requesting different window
- VENDEDOR requesting non-own data
- Seller not in requested window

**Handle in Frontend:**
```javascript
if (response.status === 403) {
  // Redirect to home, show "access denied" message
  router.push('/home');
}
```

#### Network Errors (5xx)
```javascript
fetch(url).catch(err => {
  console.error('Network error:', err);
  // Retry logic, offline mode, etc.
})
```

---

## Code Examples

### Example 1: Dashboard Summary Widget

```javascript
// React component for KPI summary
import { useEffect, useState } from 'react';

export function SalesSummary() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function fetchSummary() {
      try {
        const response = await fetch(
          '/api/v1/ventas/summary?date=today',
          {
            headers: {
              'Authorization': `Bearer ${localStorage.getItem('token')}`
            }
          }
        );

        if (!response.ok) throw new Error('Failed to fetch');

        const result = await response.json();
        setData(result.data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    fetchSummary();
    // Refresh every 5 minutes
    const interval = setInterval(fetchSummary, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error}</div>;

  return (
    <div className="kpi-grid">
      <div className="kpi-card">
        <h3>Total Sales</h3>
        <p className="value">₡{data.ventasTotal.toLocaleString()}</p>
      </div>
      <div className="kpi-card">
        <h3>Tickets</h3>
        <p className="value">{data.ticketsCount}</p>
      </div>
      <div className="kpi-card">
        <h3>Payout</h3>
        <p className="value">₡{data.payoutTotal.toLocaleString()}</p>
      </div>
      <div className="kpi-card">
        <h3>Net (after commission)</h3>
        <p className="value">₡{data.netoDespuesComision.toLocaleString()}</p>
      </div>
    </div>
  );
}
```

### Example 2: Seller Rankings Table

```javascript
// React component for breakdown by dimension
import { useState, useEffect } from 'react';

export function SellerRankings({ date = 'today', top = 10 }) {
  const [rankings, setRankings] = useState([]);

  useEffect(() => {
    async function fetchRankings() {
      const params = new URLSearchParams({
        dimension: 'vendedor',
        top,
        date
      });

      const response = await fetch(
        `/api/v1/ventas/breakdown?${params}`,
        {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`
          }
        }
      );

      const result = await response.json();
      setRankings(result.data);
    }

    fetchRankings();
  }, [date, top]);

  return (
    <table className="rankings-table">
      <thead>
        <tr>
          <th>Rank</th>
          <th>Seller</th>
          <th>Sales</th>
          <th>Tickets</th>
          <th>Winners</th>
          <th>Paid</th>
        </tr>
      </thead>
      <tbody>
        {rankings.map((seller, idx) => (
          <tr key={seller.key}>
            <td>{idx + 1}</td>
            <td>{seller.name}</td>
            <td>₡{seller.ventasTotal.toLocaleString()}</td>
            <td>{seller.ticketsCount}</td>
            <td>{seller.totalWinningTickets}</td>
            <td>{seller.totalPaidTickets}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

### Example 3: Sales Trend Chart

```javascript
// React component with Chart.js for timeseries
import { useEffect, useState } from 'react';
import { Line } from 'react-chartjs-2';

export function SalesTrendChart() {
  const [chartData, setChartData] = useState(null);

  useEffect(() => {
    async function fetchTimeseries() {
      const response = await fetch(
        '/api/v1/ventas/timeseries?granularity=day&date=month',
        {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`
          }
        }
      );

      const result = await response.json();

      setChartData({
        labels: result.data.map(point =>
          new Date(point.ts).toLocaleDateString('es-CR')
        ),
        datasets: [
          {
            label: 'Sales',
            data: result.data.map(point => point.ventasTotal),
            borderColor: '#3b82f6',
            fill: false
          },
          {
            label: 'Commission',
            data: result.data.map(point => point.commissionTotal),
            borderColor: '#ef4444',
            fill: false
          }
        ]
      });
    }

    fetchTimeseries();
  }, []);

  return chartData ? <Line data={chartData} /> : <div>Loading...</div>;
}
```

### Example 4: Date Range Selector with API

```javascript
// Custom hook for date-parameterized API calls
export function useSalesData(endpoint, dateParams = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetch = async (overrides = {}) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        ...dateParams,
        ...overrides
      });

      const response = await fetch(
        `/api/v1/ventas/${endpoint}?${params}`,
        {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`
          }
        }
      );

      if (!response.ok) throw new Error('Failed to fetch');

      const result = await response.json();
      setData(result.data);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  return { data, loading, error, fetch };
}

// Usage
export function SalesReport() {
  const { data, fetch } = useSalesData('breakdown', {
    dimension: 'vendedor'
  });

  const handleDateChange = (fromDate, toDate) => {
    fetch({
      date: 'range',
      fromDate,
      toDate
    });
  };

  return (
    <>
      <DateRangePicker onChange={handleDateChange} />
      {data && <SalesList items={data} />}
    </>
  );
}
```

### Example 5: Filter Dropdown Population

```javascript
// Use facets endpoint to populate dropdowns
export function FilterBar() {
  const [facets, setFacets] = useState(null);

  useEffect(() => {
    async function loadFacets() {
      const response = await fetch(
        '/api/v1/ventas/facets?date=month',
        {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`
          }
        }
      );

      const result = await response.json();
      setFacets(result.data);
    }

    loadFacets();
  }, []);

  return (
    <div className="filters">
      <select>
        <option>Select Window</option>
        {facets?.ventanas.map(v => (
          <option key={v.id} value={v.id}>{v.name}</option>
        ))}
      </select>

      <select>
        <option>Select Seller</option>
        {facets?.vendedores.map(v => (
          <option key={v.id} value={v.id}>{v.name}</option>
        ))}
      </select>

      <select>
        <option>Select Lottery</option>
        {facets?.loterias.map(l => (
          <option key={l.id} value={l.id}>{l.name}</option>
        ))}
      </select>
    </div>
  );
}
```

---

## Common Patterns

### Pattern 1: Daily Summary with Previous Comparison

```javascript
async function getSummaryWithComparison() {
  const [today, yesterday] = await Promise.all([
    fetch('/api/v1/ventas/summary?date=today').then(r => r.json()),
    fetch('/api/v1/ventas/summary?date=yesterday').then(r => r.json())
  ]);

  return {
    today: today.data,
    yesterday: yesterday.data,
    change: {
      sales: today.data.ventasTotal - yesterday.data.ventasTotal,
      tickets: today.data.ticketsCount - yesterday.data.ticketsCount,
      payout: today.data.payoutTotal - yesterday.data.payoutTotal
    }
  };
}
```

### Pattern 2: Hierarchical Performance Analysis

```javascript
async function getHierarchicalAnalysis(date = 'today') {
  // Get window rankings
  const windows = await fetch(
    `/api/v1/ventas/breakdown?dimension=ventana&top=5&date=${date}`
  ).then(r => r.json());

  // For each window, get seller rankings
  const results = await Promise.all(
    windows.data.map(async (window) => {
      const sellers = await fetch(
        `/api/v1/ventas/breakdown?dimension=vendedor&ventanaId=${window.key}&top=3&date=${date}`
      ).then(r => r.json());

      return {
        window: window.name,
        sales: window.ventasTotal,
        topSellers: sellers.data
      };
    })
  );

  return results;
}
```

### Pattern 3: Export Data to CSV

```javascript
async function exportToCSV(format = 'csv') {
  // Get all data (max pageSize=100, paginate if needed)
  let allData = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await fetch(
      `/api/v1/ventas?page=${page}&pageSize=100&date=month`
    ).then(r => r.json());

    allData = [...allData, ...response.data];
    hasMore = response.meta.hasNextPage;
    page++;
  }

  // Convert to CSV
  const headers = ['Ticket', 'Amount', 'Created', 'Status', 'Winner'];
  const csv = [
    headers.join(','),
    ...allData.map(item => [
      item.ticketNumber,
      item.totalAmount,
      new Date(item.createdAt).toLocaleDateString('es-CR'),
      item.status,
      item.isWinner ? 'Yes' : 'No'
    ].join(','))
  ].join('\n');

  // Download
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ventas-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
}
```

---

## Testing Checklist

### Before Going to Production

- [ ] **Authentication**
  - [ ] Request with invalid token returns 401
  - [ ] Request with expired token returns 401
  - [ ] Request without token returns 401

- [ ] **RBAC - VENDEDOR User**
  - [ ] Can call /ventas endpoints
  - [ ] Auto-filtered to own sales only
  - [ ] Cannot request other vendedorId (404 or 403)
  - [ ] Cannot request other ventanaId (403)

- [ ] **RBAC - VENTANA User**
  - [ ] Can call /ventas endpoints
  - [ ] Auto-filtered to own window
  - [ ] Can request vendedorId in own window
  - [ ] Cannot request seller from different window (403)

- [ ] **RBAC - ADMIN User**
  - [ ] Can call /ventas endpoints
  - [ ] No auto-filtering applied
  - [ ] Can cross all boundaries

- [ ] **Date Parameters**
  - [ ] `date=today` works
  - [ ] `date=yesterday` works
  - [ ] `date=week` works
  - [ ] `date=month` works
  - [ ] `date=year` works
  - [ ] `date=range&fromDate=X&toDate=Y` works
  - [ ] Invalid date format returns SLS_2001
  - [ ] Future date returns SLS_2001
  - [ ] fromDate > toDate returns SLS_2001

- [ ] **Pagination (List)**
  - [ ] Default page=1, pageSize=20
  - [ ] pageSize capped at 100
  - [ ] totalPages calculated correctly
  - [ ] hasNextPage/hasPrevPage correct
  - [ ] Last page has fewer items than pageSize

- [ ] **Breakdown**
  - [ ] All 5 dimensions work: ventana, vendedor, loteria, sorteo, numero
  - [ ] Top parameter limits results
  - [ ] Top > 50 returns SLS_2001
  - [ ] Invalid dimension returns SLS_2002
  - [ ] totalWinningTickets and totalPaidTickets are populated

- [ ] **Timeseries**
  - [ ] granularity=hour works (max 30 days)
  - [ ] granularity=day works (max 90 days)
  - [ ] granularity=week works
  - [ ] Exceeding range limits returns SLS_2001
  - [ ] Results sorted by timestamp ASC

- [ ] **Filters**
  - [ ] winnersOnly=true filters correctly
  - [ ] status parameter filters correctly
  - [ ] Search parameter finds tickets
  - [ ] Multiple filters combine (AND logic)

- [ ] **Response Structure**
  - [ ] All responses have success, data, meta
  - [ ] Date ranges in meta match request parameters
  - [ ] effectiveFilters show RBAC-applied filters
  - [ ] Timestamps are valid ISO 8601 UTC

- [ ] **Error Handling**
  - [ ] Invalid parameters return proper error codes
  - [ ] Errors include field and reason details
  - [ ] 4xx vs 5xx status codes appropriate
  - [ ] Error responses have proper structure

---

## Summary Table

| Need | Endpoint | Key Params | Best For |
|------|----------|-----------|----------|
| Detailed transactions | /ventas | page, pageSize, date, filters | Data tables, exports |
| KPI cards | /ventas/summary | date, filters | Dashboards |
| Top rankings | /ventas/breakdown | dimension, top, date | Leaderboards |
| Trend charts | /ventas/timeseries | granularity, date | Line/bar charts |
| Filter dropdowns | /ventas/facets | date | UI dropdowns |

---

## Support & Questions

For issues or clarifications:
1. Check this guide first
2. Review error code meanings in "Error Handling" section
3. Test with curl: `curl -H "Authorization: Bearer $TOKEN" "https://api.example.com/api/v1/ventas"`
4. Contact backend team with full error response

---

**Last Updated**: 2025-10-28
**API Version**: v1
**Status**: Production Ready
