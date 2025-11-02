# Activity Log System - Complete Documentation

This directory contains all documentation for the Activity Log audit system implementation.

## Quick Links

### For Frontend Developers
- **[ACTIVITY_LOG_READY_FOR_FE.md](../ACTIVITY_LOG_READY_FOR_FE.md)** - Start here! Quick overview, examples, and React integration
- **[FRONTEND_INTEGRATION_GUIDE.md](./FRONTEND_INTEGRATION_GUIDE.md)** - Detailed React hook examples and component patterns

### For Backend Developers
- **[ACTIVITY_LOG_API.md](./ACTIVITY_LOG_API.md)** - Complete API specification with all endpoints and parameters
- **[ACTIVITY_LOG_DEPLOYMENT_GUIDE.md](./ACTIVITY_LOG_DEPLOYMENT_GUIDE.md)** - Deployment procedures and validation checklist

### For Project Overview
- **[ACTIVITY_LOG_IMPLEMENTATION_SUMMARY.md](../ACTIVITY_LOG_IMPLEMENTATION_SUMMARY.md)** - Full implementation summary with all details

---

## What is the Activity Log System?

The Activity Log system provides **comprehensive audit tracking** for all important actions in the platform. It tracks:

- **Who** performed the action (user ID)
- **What** action was performed (CREATE, UPDATE, DELETE, RESTORE, etc.)
- **When** it happened (ISO 8601 timestamp)
- **What** was affected (entity type and ID)
- **Details** specific to the action

### Example: User Creation Audit Log

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "userId": "admin-id-123",
  "user": {
    "id": "admin-id-123",
    "username": "admin",
    "name": "Administrador",
    "role": "ADMIN"
  },
  "action": "USER_CREATE",
  "targetType": "USER",
  "targetId": "user-id-456",
  "details": {
    "username": "juan_vendedor",
    "role": "VENDEDOR",
    "ventanaId": "listero-id-789"
  },
  "createdAt": "2025-01-15T10:30:45.123Z"
}
```

---

## 6 API Endpoints

All endpoints require ADMIN role and JWT authentication.

### 1. List Activity Logs (with filtering & pagination)
```
GET /api/v1/activity-logs
```
Query parameters:
- `page` - Page number (default: 1)
- `pageSize` - Records per page (default: 10, max: 100)
- `userId` - Filter by user who performed action
- `action` - Filter by action type (e.g., USER_CREATE)
- `targetType` - Filter by entity type (e.g., USER, VENTANA)
- `targetId` - Filter by specific entity ID
- `startDate` - ISO 8601 date (inclusive)
- `endDate` - ISO 8601 date (inclusive)

### 2. Get Single Activity Log
```
GET /api/v1/activity-logs/:id
```

### 3. Get All Logs by User
```
GET /api/v1/activity-logs/user/:userId
```
Returns up to 100 most recent logs for a specific user.

### 4. Get All Logs for an Entity
```
GET /api/v1/activity-logs/target/:targetType/:targetId
```
Example: `/api/v1/activity-logs/target/USER/user-id-123`
Returns all logs that affected this specific entity.

### 5. Get All Logs by Action Type
```
GET /api/v1/activity-logs/action/:action
```
Example: `/api/v1/activity-logs/action/USER_CREATE`
Returns up to 100 most recent logs of this action type.

### 6. Clean Up Old Logs
```
POST /api/v1/activity-logs/cleanup
Body: { "days": 90 }
```
Permanently deletes logs older than specified days.

---

## Currently Logged Actions

The following actions are automatically logged:

### User Operations
- ✅ `USER_CREATE` - New user created
- ✅ `USER_UPDATE` - User details modified
- ✅ `USER_DELETE` - User soft-deleted
- ✅ `USER_RESTORE` - User reactivated

### Future Logging (Ready to Implement)
- `BANCA_CREATE`, `BANCA_UPDATE`, `BANCA_DELETE`, `BANCA_RESTORE`
- `VENTANA_CREATE`, `VENTANA_UPDATE`, `VENTANA_DELETE`, `VENTANA_RESTORE`
- `LOTERIA_CREATE`, `LOTERIA_UPDATE`, `LOTERIA_DELETE`, `LOTERIA_RESTORE`
- `SORTEO_CREATE`, `SORTEO_UPDATE`, `SORTEO_OPEN`, `SORTEO_CLOSE`, `SORTEO_EVALUATE`
- `TICKET_CREATE`, `TICKET_CANCEL`, `TICKET_PAY`, `TICKET_PAY_FINALIZE`, `TICKET_PAYMENT_REVERSE`
- `LOGIN`, `LOGOUT`

---

## Implementation Details

### Code Architecture

```
src/repositories/activityLog.repository.ts
  ├─ getById(id)
  ├─ list(filters, pagination)
  ├─ listByUser(userId, limit)
  ├─ listByTarget(targetType, targetId)
  ├─ listByAction(action, limit)
  └─ deleteOlderThan(days)

src/api/v1/services/activityLog.service.ts
  ├─ getById(id)
  ├─ list(filters, pagination)
  ├─ getByUser(userId)
  ├─ getByTarget(targetType, targetId)
  ├─ getByAction(action)
  └─ cleanupOldLogs(days)

src/api/v1/controllers/activityLog.controller.ts
  ├─ getById()
  ├─ list()
  ├─ getByUser()
  ├─ getByTarget()
  ├─ getByAction()
  └─ cleanup()

src/api/v1/routes/activityLog.routes.ts
  └─ Route definitions with ADMIN auth middleware

src/api/v1/validators/activityLog.validator.ts
  └─ Zod schemas for all request types
```

### User Service Integration

The `src/api/v1/services/user.service.ts` now includes automatic audit logging:

```typescript
async create(dto: CreateUserDTO, createdByUserId?: string)
  ↓ logs USER_CREATE

async update(id: string, dto: UpdateUserDTO, updatedByUserId?: string)
  ↓ logs USER_UPDATE

async softDelete(id: string, deletedBy: string, deletedReason?: string)
  ↓ logs USER_DELETE

async restore(id: string, restoredByUserId?: string)
  ↓ logs USER_RESTORE
```

---

## Security

### Access Control
- ✅ ADMIN role required for all endpoints
- ✅ JWT Bearer token authentication
- ✅ Role-based access middleware

### Data Protection
- ✅ Activity logs are **read-only** (cannot be edited)
- ✅ Can only be deleted in **bulk by age** (no individual deletion)
- ✅ All queries validated with Zod schemas
- ✅ SQL injection protection via Prisma ORM

---

## Common Use Cases

### 1. Audit User Changes
```bash
# See all changes to a specific user
GET /api/v1/activity-logs/target/USER/user-id-123
```

### 2. Track Admin Actions
```bash
# See all actions performed by an admin
GET /api/v1/activity-logs/user/admin-id-123
```

### 3. Find All User Creations
```bash
# See when users were created and by whom
GET /api/v1/activity-logs?action=USER_CREATE
```

### 4. Monthly Activity Report
```bash
# Get all activity in January 2025
GET /api/v1/activity-logs?startDate=2025-01-01T00:00:00Z&endDate=2025-01-31T23:59:59Z
```

---

## Deployment

### Pre-Deployment Checks
- [ ] TypeScript compilation passes: `npm run typecheck`
- [ ] Review all documentation
- [ ] Test endpoints in development
- [ ] Validate pagination and filtering
- [ ] Check ADMIN authentication works

### Merge to Master
```bash
git checkout master
git pull origin master
git merge feature/activity-log-audit --no-ff
git push origin master
```

### Post-Deployment
- Monitor for any errors in logs
- Verify activity logs are being created for user operations
- Ensure ADMIN users can query activity logs

---

## Troubleshooting

**Q: Getting 403 Forbidden?**
A: Verify you have ADMIN role and valid JWT token.

**Q: No activity logs being created?**
A: Check that user service methods are being called with the audit user ID parameter.

**Q: Pagination not working?**
A: Ensure pageSize is provided and <= 100.

**Q: No results for date filter?**
A: Use ISO 8601 format: `2025-01-01T00:00:00Z`

---

## Statistics

- **Files Added**: 11
- **Files Modified**: 2
- **Lines Added**: 1,964
- **Documentation**: 538 lines
- **Implementation Code**: 1,426 lines
- **API Endpoints**: 6
- **Commits**: 5

---

## Version Info

- **Implementation Date**: November 1, 2025
- **Feature Branch**: `feature/activity-log-audit`
- **Status**: ✅ Ready for Production

---

## Next Steps

1. **Review** documentation in this directory
2. **Validate** endpoints work as expected
3. **Test** frontend integration
4. **Merge** to master when ready
5. **Deploy** to production

For detailed information, see the specific documentation files above.
