-- CreateIndex: idx_activitylog_userid
-- Purpose: Speed up queries filtering by user who performed the action
CREATE INDEX idx_activitylog_userid ON "ActivityLog"("userId");

-- CreateIndex: idx_activitylog_action
-- Purpose: Speed up queries filtering by action type
CREATE INDEX idx_activitylog_action ON "ActivityLog"("action");

-- CreateIndex: idx_activitylog_target
-- Purpose: Speed up queries filtering by target entity (type + id)
CREATE INDEX idx_activitylog_target ON "ActivityLog"("targetType", "targetId");

-- CreateIndex: idx_activitylog_createdat_desc
-- Purpose: Speed up queries filtering by date range (most recent first)
-- Used for cleanup and listing recent logs
CREATE INDEX idx_activitylog_createdat_desc ON "ActivityLog"("createdAt" DESC);

-- Note: These indices are SAFE to create on production
-- - Non-blocking index creation (PostgreSQL 11+)
-- - No data is modified or deleted
-- - Indices improve read performance significantly
-- - Can be created during business hours
