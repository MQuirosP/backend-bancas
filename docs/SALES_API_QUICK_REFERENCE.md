# Sales API - Quick Reference

## 5 Endpoints at a Glance

```
GET /ventas                    → List (detail rows, paginated)
GET /ventas/summary            → KPI (single aggregated record)
GET /ventas/breakdown          → Rankings (top-N by dimension)
GET /ventas/timeseries         → Trends (time-bucketed data)
GET /ventas/facets             → Filters (available values)
```

---

## Universal Query Parameters

Apply to almost all endpoints:

```
?date=today|yesterday|week|month|year|range
?fromDate=YYYY-MM-DD                      (if date=range)
?toDate=YYYY-MM-DD                        (if date=range)
?winnersOnly=true|false
?status=ACTIVE|EVALUATED|CANCELLED|RESTORED
?ventanaId=UUID
?vendedorId=UUID
?loteriaId=UUID
?sorteoId=UUID
```

---

## Endpoint-Specific Parameters

### /ventas (List)
```
?page=1
?pageSize=20                  (max 100)
?search=text                  (ticket number, name, etc)
?orderBy=createdAt|-totalAmount
```

### /ventas/breakdown
```
?dimension=vendedor|ventana|loteria|sorteo|numero  (REQUIRED)
?top=10                       (max 50)
```

### /ventas/timeseries
```
?granularity=hour|day|week
  Note: hour (max 30d), day (max 90d), week (unlimited)
```

### /ventas/summary
No additional parameters

### /ventas/facets
No additional parameters

---

## Quick Copy-Paste Examples

### Today's Summary
```
/ventas/summary?date=today
```

### Top 10 Sellers This Month
```
/ventas/breakdown?dimension=vendedor&date=month&top=10
```

### Last 7 Days by Day
```
/ventas/timeseries?granularity=day&date=week
```

### Winners Only, This Week
```
/ventas?date=week&winnersOnly=true&pageSize=50
```

### Custom Date Range Breakdown
```
/ventas/breakdown?dimension=numero&date=range&fromDate=2025-10-01&toDate=2025-10-27&top=20
```

### Available Filters This Month
```
/ventas/facets?date=month
```

### Search for Ticket
```
/ventas?search=T250126&pageSize=100
```

### Top Windows, Sort by Revenue
```
/ventas/breakdown?dimension=ventana&top=10&date=today
```

---

## Response Fields

### /ventas (List Item)
```json
{
  "id": "uuid",
  "ticketNumber": "T250126-00000A-42",
  "totalAmount": 50000,
  "createdAt": "2025-10-27T10:30:45.123Z",
  "status": "ACTIVE|EVALUATED|CANCELLED|RESTORED",
  "isWinner": boolean,
  "ventana": { "id", "name", "code" },
  "vendedor": { "id", "name", "username" },
  "loteria": { "id", "name" },
  "sorteo": { "id", "name", "scheduledAt", "status" },
  "jugadas": [
    { "id", "type", "number", "amount", "finalMultiplierX", "payout", "isWinner" }
  ]
}
```

### /ventas/summary
```json
{
  "ventasTotal": number,
  "ticketsCount": number,
  "jugadasCount": number,
  "payoutTotal": number,
  "neto": number,
  "commissionTotal": number,
  "netoDespuesComision": number,
  "lastTicketAt": "ISO_DATETIME"
}
```

### /ventas/breakdown (Item)
```json
{
  "key": "uuid|number",
  "name": "string",
  "ventasTotal": number,
  "ticketsCount": number,
  "payoutTotal": number,
  "neto": number,
  "commissionTotal": number,
  "totalWinningTickets": number,
  "totalPaidTickets": number
}
```

### /ventas/timeseries (Item)
```json
{
  "ts": "2025-10-27T06:00:00.000Z",
  "ventasTotal": number,
  "ticketsCount": number,
  "commissionTotal": number
}
```

### /ventas/facets
```json
{
  "ventanas": [{ "id", "name", "code" }],
  "vendedores": [{ "id", "name", "username" }],
  "loterias": [{ "id", "name" }],
  "sorteos": [{ "id", "name", "scheduledAt" }]
}
```

### Pagination Meta (List only)
```json
{
  "total": number,
  "page": number,
  "pageSize": number,
  "totalPages": number,
  "hasNextPage": boolean,
  "hasPrevPage": boolean
}
```

### Range Meta (All endpoints)
```json
{
  "range": {
    "fromAt": "2025-10-27T06:00:00.000Z",
    "toAt": "2025-10-28T05:59:59.999Z",
    "tz": "America/Costa_Rica"
  }
}
```

---

## Date Behavior

| Semantic | Means | Example |
|----------|-------|---------|
| today | Current day CR | 2025-10-27 |
| yesterday | Previous day | 2025-10-26 |
| week | Mon-Sun current | 2025-10-20 to 2025-10-26 |
| month | 1st-last current | 2025-10-01 to 2025-10-31 |
| year | Jan 1-Dec 31 current | 2025-01-01 to 2025-12-31 |
| range | Custom dates | Specify fromDate & toDate |

**Timezone**: All dates interpreted as Costa Rica (UTC-6)
**Format**: YYYY-MM-DD for parameters, ISO 8601 UTC in responses

---

## RBAC Auto-Filtering

### VENDEDOR
- Auto-filter: `vendedorId = your_id`
- Cannot override
- Result: See own sales only

### VENTANA
- Auto-filter: `ventanaId = your_window`
- Can filter: `vendedorId` (must be in your window)
- Result: See window + can slice by seller

### ADMIN
- No auto-filter
- Can request anything
- Result: See all data

---

## Error Codes

| Code | Status | Problem |
|------|--------|---------|
| SLS_2001 | 400 | Invalid date, range exceeded, bad granularity |
| SLS_2002 | 400 | Invalid dimension, missing required param |
| RBAC_001 | 403 | Accessing other window (VENTANA/VENDEDOR) |
| RBAC_002 | 403 | Seller not in your window (VENTANA) |
| (any) | 401 | No/invalid/expired JWT token |

Response format:
```json
{
  "success": false,
  "error": {
    "message": "...",
    "code": "ERROR_CODE",
    "statusCode": 400|403|401|500,
    "details": [{ "field": "...", "reason": "..." }]
  }
}
```

---

## Typical Workflows

### Dashboard
1. **Summary card** → `/ventas/summary?date=today`
2. **KPI comparison** → Call `/summary` with date=today AND date=yesterday, compare
3. **Top performers** → `/breakdown?dimension=vendedor&date=today&top=5`
4. **Recent activity** → `/ventas?date=today&pageSize=10&orderBy=-createdAt`

### Filter UI
1. **Load dropdowns** → `/facets?date=month`
2. **On filter change** → Re-call endpoint with new filters

### Charts
1. **Trend chart** → `/timeseries?granularity=day&date=month`
2. **Update on date picker** → Call with new date range

### Export
1. **Get all data** → Loop `/ventas?page=1,2,3...` with pageSize=100 until hasNextPage=false
2. **Format as CSV/XLSX**
3. **Download to user**

---

## Common Mistakes

❌ Sending ISO datetime for date params
```javascript
?fromDate=2025-10-27T06:00:00Z  // WRONG
```

✅ Send calendar date only
```javascript
?fromDate=2025-10-27  // CORRECT
```

---

❌ Trying to override RBAC
```javascript
// VENDEDOR trying to request another seller
?vendedorId=OTHER_SELLER_UUID  // Returns 403
```

✅ Work within your scope
```javascript
// VENDEDOR: system auto-filters to you
// No need to include vendedorId param
```

---

❌ Exceeding timeseries limits
```javascript
?granularity=hour&date=range&fromDate=2025-01-01&toDate=2025-10-27  // 300 days! Error
```

✅ Stay within limits
```javascript
?granularity=hour&date=week  // 7 days, OK
?granularity=day&date=range&fromDate=2025-09-01&toDate=2025-10-27  // ~60 days, OK
```

---

## Helper Function

```javascript
function formatCRDate(date = new Date()) {
  return date.toISOString().split('T')[0];  // → YYYY-MM-DD
}

// Use in API calls
const today = formatCRDate();
const yesterday = formatCRDate(new Date(Date.now() - 86400000));

fetch(`/api/v1/ventas/summary?date=range&fromDate=${yesterday}&toDate=${today}`)
```

---

## Node.js Fetch Example

```javascript
const token = 'your_jwt_token';

async function getTopSellers(date = 'today') {
  const response = await fetch(
    `https://api.example.com/api/v1/ventas/breakdown?dimension=vendedor&top=10&date=${date}`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );

  if (!response.ok) {
    const error = await response.json();
    console.error(`Error (${error.error.code}):`, error.error.message);
    return null;
  }

  const result = await response.json();
  return result.data;
}

// Usage
getTopSellers('week').then(sellers => {
  sellers.forEach((s, i) => {
    console.log(`${i+1}. ${s.name}: ₡${s.ventasTotal.toLocaleString()}`);
  });
});
```

---

## curl Examples

```bash
# Get summary
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.example.com/api/v1/ventas/summary?date=today"

# Get breakdown
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.example.com/api/v1/ventas/breakdown?dimension=vendedor&top=10&date=week"

# Get timeseries
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.example.com/api/v1/ventas/timeseries?granularity=day&date=month"

# Get with custom dates
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.example.com/api/v1/ventas?date=range&fromDate=2025-10-01&toDate=2025-10-27&pageSize=50"
```

---

## Validation Quick Check

Before sending to API:

- [ ] Date format is YYYY-MM-DD (not ISO)
- [ ] date parameter is one of: today, yesterday, week, month, year, range
- [ ] If date=range, both fromDate and toDate provided
- [ ] toDate >= fromDate
- [ ] pageSize <= 100 (List only)
- [ ] top <= 50 (Breakdown only)
- [ ] granularity is hour, day, or week (Timeseries only)
- [ ] If granularity=hour, range <= 30 days
- [ ] If granularity=day, range <= 90 days
- [ ] Token is valid and not expired

---

**For full details**, see `FRONTEND_SALES_API_GUIDE.md`
