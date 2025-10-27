# Date Parameters Testing Checklist

**Date**: 2025-10-27
**Status**: ⚠️ TO BE EXECUTED AFTER FRONTEND UPDATES
**Target**: Verify backend date resolution works correctly

---

## Pre-Test Setup

- [ ] Backend running locally or on staging
- [ ] Frontend updated per `FRONTEND_DATE_STRATEGY.md`
- [ ] Server time synchronized (check `date` command)
- [ ] CR timezone configured on server (UTC-6)
- [ ] Browser console open to check logs

---

## Test 1: Today Token Idempotency

**Objective**: Same request at different times returns same data

**Steps**:
1. Note current time: _______________
2. Run:
   ```bash
   curl "http://localhost:3000/api/v1/ventas?date=today&pageSize=1" | jq .
   # Note the data count: _______________
   ```
3. Wait 1 hour
4. Run same command again
5. Compare data counts - should be identical

**Expected Result**: ✅ Exact same data count both times

**Log Verification**: Check backend logs for dateRange:
```json
{
  "dateRange": {
    "fromAt": "2025-10-27T06:00:00.000Z",
    "toAt": "2025-10-28T05:59:59.999Z"
  }
}
```

---

## Test 2: Token to Date Range Mapping

**Objective**: Each token produces correct CR timezone boundaries

### Test 2A: Today

```bash
curl "http://localhost:3000/api/v1/ventas?date=today"
```

Check log shows:
- `fromAt`: 2025-10-27T06:00:00.000Z  (current date 00:00 CR)
- `toAt`: 2025-10-28T05:59:59.999Z    (current date 23:59:59 CR)

- [ ] fromAt is 06:00:00 UTC ✅
- [ ] toAt is 05:59:59.999 UTC ✅

### Test 2B: Yesterday

```bash
curl "http://localhost:3000/api/v1/ventas?date=yesterday"
```

Check log shows:
- `fromAt`: 2025-10-26T06:00:00.000Z  (previous date 00:00 CR)
- `toAt`: 2025-10-27T05:59:59.999Z    (previous date 23:59:59 CR)

- [ ] Previous day boundaries correct ✅

### Test 2C: Week

```bash
curl "http://localhost:3000/api/v1/ventas?date=week"
```

Check log shows:
- `fromAt`: 2025-10-27T06:00:00.000Z  (Monday 00:00 CR)
- `toAt`: 2025-11-03T05:59:59.999Z    (Sunday 23:59:59 CR)

- [ ] Week starts on Monday ✅
- [ ] Week ends on Sunday ✅
- [ ] Full 7 days included ✅

### Test 2D: Month

```bash
curl "http://localhost:3000/api/v1/ventas?date=month"
```

Check log shows:
- `fromAt`: 2025-10-01T06:00:00.000Z  (Oct 1 00:00 CR)
- `toAt`: 2025-11-01T05:59:59.999Z    (Oct 31 23:59:59 CR)

- [ ] Month starts on 1st ✅
- [ ] Month ends on last day ✅

### Test 2E: Year

```bash
curl "http://localhost:3000/api/v1/ventas?date=year"
```

Check log shows:
- `fromAt`: 2025-01-01T06:00:00.000Z  (Jan 1 00:00 CR)
- `toAt`: 2026-01-01T05:59:59.999Z    (Dec 31 23:59:59 CR)

- [ ] Year starts Jan 1 ✅
- [ ] Year ends Dec 31 ✅

---

## Test 3: Custom Range

**Objective**: Custom YYYY-MM-DD ranges work correctly

```bash
curl "http://localhost:3000/api/v1/ventas?date=range&fromDate=2025-10-20&toDate=2025-10-27"
```

Check log shows:
- `fromAt`: 2025-10-20T06:00:00.000Z  (Oct 20 00:00 CR)
- `toAt`: 2025-10-28T05:59:59.999Z    (Oct 27 23:59:59 CR)

- [ ] From date interpreted correctly ✅
- [ ] To date includes full day ✅
- [ ] No timezone confusion ✅

---

## Test 4: All Endpoints Support Date Tokens

### Test 4A: Ventas Summary

```bash
curl "http://localhost:3000/api/v1/ventas/summary?date=week"
```

- [ ] Returns 200 ✅
- [ ] Includes dateRange in log ✅

### Test 4B: Ventas Breakdown

```bash
curl "http://localhost:3000/api/v1/ventas/breakdown?date=month&dimension=ventana"
```

- [ ] Returns 200 ✅
- [ ] dimension parameter works ✅

### Test 4C: Ventas Timeseries

```bash
curl "http://localhost:3000/api/v1/ventas/timeseries?date=week&granularity=day"
```

- [ ] Returns 200 ✅
- [ ] granularity parameter works ✅
- [ ] Returns daily data for 7 days ✅

### Test 4D: Dashboard Main

```bash
curl "http://localhost:3000/api/v1/admin/dashboard?date=month"
```

- [ ] Returns 200 ✅
- [ ] Returns Ganancia metrics ✅

### Test 4E: Dashboard Ganancia

```bash
curl "http://localhost:3000/api/v1/admin/dashboard/ganancia?date=week"
```

- [ ] Returns 200 ✅

### Test 4F: Dashboard CxC

```bash
curl "http://localhost:3000/api/v1/admin/dashboard/cxc?date=today"
```

- [ ] Returns 200 ✅

### Test 4G: Dashboard CxP

```bash
curl "http://localhost:3000/api/v1/admin/dashboard/cxp?date=year"
```

- [ ] Returns 200 ✅

---

## Test 5: Error Handling

### Test 5A: Invalid Date Token

```bash
curl "http://localhost:3000/api/v1/ventas?date=invalid"
```

**Expected**: 400 response
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

- [ ] Returns 400 ✅
- [ ] Code is SLS_2001 ✅
- [ ] Error message lists all valid tokens ✅

### Test 5B: Range Without Dates

```bash
curl "http://localhost:3000/api/v1/ventas?date=range"
```

**Expected**: 400 response
```json
{
  "error": {
    "code": "SLS_2001",
    "details": [
      {
        "field": "fromDate",
        "reason": "Required when date=range"
      }
    ]
  }
}
```

- [ ] Returns 400 ✅
- [ ] Indicates missing fromDate ✅

### Test 5C: Invalid Date Format

```bash
curl "http://localhost:3000/api/v1/ventas?date=range&fromDate=2025/10/20&toDate=2025-10-27"
```

**Expected**: 400 response about invalid fromDate format

- [ ] Returns 400 ✅
- [ ] Points to fromDate as problematic ✅
- [ ] Error message says "Use format YYYY-MM-DD" ✅

### Test 5D: Future Date

```bash
curl "http://localhost:3000/api/v1/ventas?date=range&fromDate=2025-12-01&toDate=2025-12-31"
```

**Expected**: 400 response (future date)

- [ ] Returns 400 ✅
- [ ] Error says "toDate cannot be in the future" ✅

### Test 5E: fromDate > toDate

```bash
curl "http://localhost:3000/api/v1/ventas?date=range&fromDate=2025-10-27&toDate=2025-10-20"
```

**Expected**: 400 response

- [ ] Returns 400 ✅
- [ ] Error says "fromDate must be ≤ toDate" ✅

---

## Test 6: Data Consistency

**Objective**: Verify date boundaries don't miss or double-count data

### Setup
1. Create a test sale at 2025-10-27 23:59:00 CR (5:59:00 UTC)
2. Create another at 2025-10-28 00:01:00 CR (6:01:00 UTC)

### Test 6A: Today includes late evening sale

```bash
curl "http://localhost:3000/api/v1/ventas?date=today"
```

- [ ] Includes sale at 23:59:00 ✅
- [ ] Does NOT include sale at next day 00:01:00 ✅

### Test 6B: Yesterday excludes today's data

```bash
curl "http://localhost:3000/api/v1/ventas?date=yesterday"
```

- [ ] Does NOT include today's sales ✅
- [ ] No double-counting ✅

---

## Test 7: Cross-Endpoint Consistency

**Objective**: Same date token returns consistent data across endpoints

```bash
# Summary for today
curl "http://localhost:3000/api/v1/ventas/summary?date=today" | jq '.data.ventasTotal'

# Individual list for today
curl "http://localhost:3000/api/v1/ventas?date=today&pageSize=1000" | jq '.data | length'

# Should aggregate to same total across endpoints
```

- [ ] Summary count matches list count ✅
- [ ] No discrepancies between endpoints ✅

---

## Test 8: Timezone Edge Cases

### Test 8A: Midnight CR vs UTC

At exactly 2025-10-27T06:00:00Z (2025-10-27 00:00 in CR):

```bash
curl "http://localhost:3000/api/v1/ventas?date=today"
```

Should include transactions from this exact moment

- [ ] Includes 00:00:00 CR transactions ✅

### Test 8B: End of Day Precision

At exactly 2025-10-28T05:59:59.999Z (2025-10-27 23:59:59 in CR):

```bash
curl "http://localhost:3000/api/v1/ventas?date=today"
```

Should still be within "today"

- [ ] Includes last millisecond of day ✅

---

## Test 9: Frontend Integration

### Test 9A: Dashboard Loads with New Date Tokens

1. Navigate to Admin Dashboard
2. Check network tab for requests

```
GET /api/v1/admin/dashboard?date=today
GET /api/v1/ventas/summary?date=today
GET /api/v1/ventas/breakdown?date=today
```

- [ ] All requests use `date=` not `timeframe=` ✅
- [ ] All return 200 OK ✅
- [ ] Dashboard displays data correctly ✅

### Test 9B: Date Selector Works

1. Click date selector (week, month, year)
2. Verify correct requests are sent

```
Before click: ?date=today
After click week: ?date=week
After click month: ?date=month
```

- [ ] Tokens change correctly ✅
- [ ] Data updates on selection ✅

### Test 9C: Custom Range Picker

1. Open custom date range picker
2. Select Oct 1 to Oct 27
3. Verify request

```
GET /api/v1/ventas?date=range&fromDate=2025-10-01&toDate=2025-10-27
```

- [ ] Sends YYYY-MM-DD format ✅
- [ ] Not ISO timestamps ✅
- [ ] Data loads correctly ✅

---

## Test 10: Performance

### Test 10A: Large Date Range

```bash
time curl "http://localhost:3000/api/v1/ventas?date=range&fromDate=2025-01-01&toDate=2025-10-27&pageSize=1000"
```

- [ ] Responds in < 2 seconds ✅
- [ ] No timeout errors ✅

### Test 10B: Concurrent Requests

```bash
# Run 10 requests in parallel
for i in {1..10}; do
  curl "http://localhost:3000/api/v1/ventas?date=week" &
done
wait
```

- [ ] All requests complete ✅
- [ ] No race conditions ✅

---

## Test 11: Logging Verification

Check backend logs for proper dateRange information:

```bash
tail -f /var/log/app.log | grep "dateRange"
```

Expected log format:
```json
{
  "requestId": "xyz",
  "layer": "controller",
  "action": "VENTA_LIST",
  "payload": {
    "dateRange": {
      "fromAt": "2025-10-27T06:00:00.000Z",
      "toAt": "2025-10-28T05:59:59.999Z",
      "tz": "America/Costa_Rica",
      "description": "Today (2025-10-27) in America/Costa_Rica"
    }
  }
}
```

- [ ] All requests log dateRange ✅
- [ ] Description matches token ✅
- [ ] UTC times are correct ✅
- [ ] Timezone is always "America/Costa_Rica" ✅

---

## Test 12: RBAC with Date Filters

### Test 12A: VENDEDOR can only see own sales

```bash
# As VENDEDOR user
curl -H "Authorization: Bearer $VENDEDOR_TOKEN" \
  "http://localhost:3000/api/v1/ventas?date=today&scope=mine"
```

- [ ] Returns only own sales ✅
- [ ] Date filter applied ✅

### Test 12B: VENTANA can see their window

```bash
# As VENTANA user
curl -H "Authorization: Bearer $VENTANA_TOKEN" \
  "http://localhost:3000/api/v1/admin/dashboard?date=week"
```

- [ ] Returns own ventana metrics ✅
- [ ] Date filter applied ✅

### Test 12C: ADMIN sees all

```bash
# As ADMIN user
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:3000/api/v1/ventas?date=month"
```

- [ ] Returns all sales ✅
- [ ] Date filter applied ✅

---

## Final Sign-Off

- [ ] All tests completed
- [ ] No failures found
- [ ] Logs verified
- [ ] Frontend integration tested
- [ ] Performance acceptable
- [ ] RBAC still working
- [ ] Ready for production

**Test Date**: _______________
**Tester Name**: _______________
**Notes**:
```
[Use this space for any issues found]
```

---

## Troubleshooting

### Issue: Wrong date range in logs

**Check**:
- Is server time synchronized? `date` command should match
- Is timezone set to UTC? (`TZ=UTC node app.js`)
- Review `src/utils/dateRange.ts` date calculations

### Issue: Data seems to be shifted by hours

**Check**:
- Verify `TZ_OFFSET_HOURS = -6` in dateRange.ts
- Verify all date calculations use UTC math
- Check server system timezone (should be UTC internally)

### Issue: Custom range not working

**Check**:
- Format is YYYY-MM-DD? (not YYYY/MM/DD or MM-DD-YYYY)
- Is toDate <= today? (future dates rejected)
- Is fromDate <= toDate? (reverse ranges rejected)

---

**Questions?** Refer to:
- `docs/DATE_PARAMETERS_STANDARDIZATION.md` - Technical details
- `docs/FRONTEND_DATE_STRATEGY.md` - Frontend implementation
- `src/utils/dateRange.ts` - Implementation source code

