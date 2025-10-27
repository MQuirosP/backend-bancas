# Backend Documentation

This directory contains comprehensive documentation for the Banca Management Backend system.

---

## Date Parameters Standardization (CRITICAL - 2025-10-27)

### Executive Summary

The backend discovered and fixed a critical date handling issue:

**The Problem**: Frontend was calculating date ranges on the client (UTC timezone), causing:
- Timezone confusion (client vs server timezone)
- Security vulnerability (client time can be manipulated)
- Inconsistent results across queries
- Audit trail ambiguity

**The Solution**: Backend is now the sole authority for all date calculations using Costa Rica timezone (UTC-6).

### Key Documents (Read in Order)

#### For Frontend Developers

1. **[UNIVERSAL_DATE_PARAMETER_STANDARD.md](./UNIVERSAL_DATE_PARAMETER_STANDARD.md)** ⭐⭐⭐ START HERE
   - The law: What every endpoint accepts
   - No exceptions policy
   - Token resolution reference
   - Implementation rules (5 critical rules)

2. **[FRONTEND_DATE_IMPLEMENTATION_SPEC.md](./FRONTEND_DATE_IMPLEMENTATION_SPEC.md)** ⭐⭐⭐ FOR CODING
   - Step-by-step implementation guide
   - 6 copy-paste ready code examples
   - React hooks and utilities
   - Error handling patterns
   - Testing checklist
   - Migration path for existing code

#### For Decision Makers & QA

3. **[BACKEND_AUTHORITY_MODEL_SUMMARY.md](./BACKEND_AUTHORITY_MODEL_SUMMARY.md)** ⭐ EXECUTIVE SUMMARY
   - Why backend is authority (security & consistency)
   - What was fixed
   - What frontend must do
   - Before/after examples

4. **[DATE_TESTING_CHECKLIST.md](./DATE_TESTING_CHECKLIST.md)** ⭐ FOR QA TEAM
   - 12-part comprehensive testing plan
   - Specific curl commands
   - Expected log outputs
   - Edge cases and error scenarios

#### Technical Reference

5. **[DATE_PARAMETERS_STANDARDIZATION.md](./DATE_PARAMETERS_STANDARDIZATION.md)**
   - Technical deep-dive of all changes
   - Endpoint-by-endpoint breakdown
   - Error codes and responses

6. **[PARAMETER_VALIDATION_AUDIT.md](./PARAMETER_VALIDATION_AUDIT.md)**
   - What discrepancies were found
   - How they were fixed
   - Code changes made

7. **[API_ENDPOINT_PARAMETERS_REFERENCE.md](./API_ENDPOINT_PARAMETERS_REFERENCE.md)**
   - Complete reference for all endpoints
   - Parameter details with examples
   - RBAC rules for each endpoint

8. **[PARAMETER_VALIDATION_FINAL_SUMMARY.md](./PARAMETER_VALIDATION_FINAL_SUMMARY.md)**
   - Complete audit results
   - Verification checklist
   - Production readiness status

### Quick Reference

**Supported Date Tokens**: `today`, `yesterday`, `week`, `month`, `year`, `range`

**Format**:
```
GET /endpoint?date={token}&fromDate={optional}&toDate={optional}
```

**Examples**:
```
GET /api/v1/ventas?date=today
GET /api/v1/ventas?date=week
GET /api/v1/ventas?date=range&fromDate=2025-10-01&toDate=2025-10-27
GET /api/v1/admin/dashboard?date=month
```

**Critical**: Frontend must NOT calculate dates. Send tokens only, backend resolves using server time.

---

## Dashboard & Ticket Payment Implementation

### Documents

- **[DASHBOARD_TICKET_PAYMENT_STRATEGY.md](./DASHBOARD_TICKET_PAYMENT_STRATEGY.md)** - Complete implementation details
- **[IMPLEMENTATION_COMPLETION_SUMMARY.md](./IMPLEMENTATION_COMPLETION_SUMMARY.md)** - Status and testing results

### Key Features

#### Dashboard Metrics
- **Ganancia** - Commission revenue from winning bets
- **CxC** - Accounts receivable (sales minus prizes paid)
- **CxP** - Accounts payable (when ventana overpaid)

#### Ticket Payment Module
- Register partial and full payments
- Track payment status and history
- Reverse payments (refund)
- Finalize partial payments
- Activity logging for audit trail

#### RBAC Applied
- VENDEDOR: Can only see own tickets
- VENTANA: Can see own window's tickets
- ADMIN: Can see all data

---

## Database Schema Changes

### Commission System
- `commissionPolicyJson` - JSON-based policy per user/ventana/banca
- `commissionPercent`, `commissionAmount` - Calculated values per bet
- Hierarchical resolution: USER → VENTANA → BANCA

### Ticket Payment
- `isFinal` - Whether partial payment marks ticket as complete
- `completedAt` - Timestamp when payment completed
- `PAGADO` status - New ticket status when payment is finalized

---

## All Available Endpoints

### Ventas (Sales)
```
GET /api/v1/ventas                  - List all sales with filters
GET /api/v1/ventas/summary          - Aggregated metrics
GET /api/v1/ventas/breakdown        - Breakdown by dimension
GET /api/v1/ventas/timeseries       - Time-based trends
GET /api/v1/ventas/facets           - Available filter values
```

### Dashboard
```
GET /api/v1/admin/dashboard         - Main dashboard
GET /api/v1/admin/dashboard/ganancia - Commission metrics
GET /api/v1/admin/dashboard/cxc     - Receivables metrics
GET /api/v1/admin/dashboard/cxp     - Payables metrics
```

### Ticket Payments
```
GET /api/v1/ticket-payments         - List payments
POST /api/v1/ticket-payments        - Create payment
GET /api/v1/ticket-payments/:id     - Get payment details
PUT /api/v1/ticket-payments/:id     - Update payment (finalize)
DELETE /api/v1/ticket-payments/:id  - Reverse payment
GET /api/v1/ticket-payments/:id/history - Payment audit trail
```

All endpoints support `?date={token}` parameter.

---

## Code Structure

### Core Utilities
- `src/utils/dateRange.ts` - Date token resolution with CR timezone
- `src/core/types.ts` - TypeScript interfaces and enums
- `src/core/errors.ts` - Error handling and codes

### Services
- `src/api/v1/services/venta.service.ts` - Sales logic
- `src/api/v1/services/dashboard.service.ts` - Dashboard calculations
- `src/api/v1/services/ticketPayment.service.ts` - Payment logic

### Controllers
- `src/api/v1/controllers/venta.controller.ts`
- `src/api/v1/controllers/dashboard.controller.ts`
- `src/api/v1/controllers/ticketPayment.controller.ts`

### Validators
- `src/api/v1/validators/` - Zod schemas for query/body validation

### Routes
- `src/api/v1/routes/` - Express route definitions

---

## Testing

### TypeScript Validation
```bash
npm run typecheck
```
✅ All type checks passing

### Running Tests
```bash
npm test
```

### Manual Testing with curl
See [DATE_TESTING_CHECKLIST.md](./DATE_TESTING_CHECKLIST.md) for comprehensive testing scenarios.

---

## Deployment Checklist

Before deploying date changes:

- [ ] Frontend updated per FRONTEND_DATE_STRATEGY.md
- [ ] TypeScript validation passing (`npm run typecheck`)
- [ ] All endpoints tested with new date tokens
- [ ] QA checklist completed
- [ ] Server time synchronized (NTP)
- [ ] Server timezone set to UTC internally
- [ ] Logs configured to show dateRange data
- [ ] Monitoring alerts set up for date-related errors

---

## Common Issues

### Issue: 400 Error on Date Parameter

**Cause**: Frontend sending unsupported token (e.g., `thisWeek`, `last7days`)

**Solution**: Update frontend to send supported tokens: `today`, `yesterday`, `week`, `month`, `year`, `range`

**Reference**: See FRONTEND_DATE_STRATEGY.md

### Issue: Date Range Misaligned by Hours

**Cause**: Timezone confusion or client time mismatch

**Solution**: Ensure all calculations use UTC internally. Backend handles CR timezone conversion.

**Reference**: See DATE_PARAMETERS_STANDARDIZATION.md "Timezone Handling"

### Issue: Timeseries Data Missing Last Hour

**Cause**: `toAt` was exactly at midnight UTC instead of 23:59:59.999 CR

**Status**: ✅ FIXED in commit a1cbdf1

---

## Git History

Key commits related to date parameter work:

```
27ba144 docs: add comprehensive QA testing checklist for date parameters
60ef874 docs: add executive summary for backend authority model
6bafc2c docs: add comprehensive backend authority model and frontend strategy guides
a1cbdf1 fix: correct date range end time calculation for CR timezone
2cfca35 fix: standardize date parameters across all API endpoints
```

---

## References

### External Standards
- **Timezone**: America/Costa_Rica (UTC-6, no DST)
- **Date Format**: YYYY-MM-DD for query parameters
- **Timestamps**: ISO 8601 UTC (2025-10-27T06:00:00.000Z)
- **HTTP Status Codes**: Standard REST conventions

### Internal Standards
- **Error Codes**: SLS_2001 for date validation errors
- **Logging**: Activity types defined in ActivityType enum
- **RBAC**: Three roles (ADMIN, VENTANA, VENDEDOR)
- **Soft Deletes**: Using `deletedAt IS NULL` pattern

---

## Contact & Questions

For questions about:
- **Date parameters**: Review DATE_PARAMETERS_STANDARDIZATION.md
- **Frontend migration**: Review FRONTEND_DATE_STRATEGY.md
- **Testing**: Review DATE_TESTING_CHECKLIST.md
- **Implementation details**: Review source code with line references in docs

---

**Last Updated**: 2025-10-27
**Status**: ✅ Backend complete | ⚠️ Frontend update in progress
**Next Review**: After frontend integration complete and QA testing finished

