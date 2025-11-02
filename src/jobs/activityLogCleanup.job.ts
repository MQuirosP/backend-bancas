/**
 * Activity Log Cleanup Job
 *
 * Automatically deletes activity logs older than 45 days
 * Prevents database from growing indefinitely
 *
 * Usage:
 *   - Import in main app file
 *   - Call startActivityLogCleanupJob() to initialize
 *
 * Schedule: Runs daily at 2:00 AM UTC
 * Retention: 45 days of logs
 */

import ActivityLogService from '../api/v1/services/activityLog.service';

// Simplified scheduler (no external dependencies)
// If you want to use a library like node-cron or agenda, replace this

let cleanupTimer: NodeJS.Timeout | null = null;

/**
 * Calculate milliseconds until next 2 AM UTC
 */
function getMillisecondsUntilNextCleanup(): number {
  const now = new Date();
  const next = new Date(now);

  // Set to 2 AM UTC
  next.setUTCHours(2, 0, 0, 0);

  // If 2 AM has already passed today, schedule for tomorrow
  if (next <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  return next.getTime() - now.getTime();
}

/**
 * Execute the cleanup job
 * Deletes logs older than 45 days
 */
async function executeCleanup(): Promise<void> {
  const RETENTION_DAYS = 45;

  try {
    console.log(`[Activity Log Cleanup] Starting cleanup job at ${new Date().toISOString()}`);
    console.log(`[Activity Log Cleanup] Deleting logs older than ${RETENTION_DAYS} days...`);

    const result = await ActivityLogService.cleanupOldLogs(RETENTION_DAYS);

    console.log(`[Activity Log Cleanup] ✅ Cleanup completed successfully`);
    console.log(`[Activity Log Cleanup] Deleted ${result.deletedCount} activity log records`);

    // Log to monitoring system if available
    if (process.env.CLEANUP_WEBHOOK_URL) {
      try {
        await fetch(process.env.CLEANUP_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'activity_log_cleanup',
            timestamp: new Date().toISOString(),
            deletedCount: result.deletedCount,
            status: 'success',
          }),
        });
      } catch (error) {
        console.error('[Activity Log Cleanup] Error sending webhook:', error);
      }
    }
  } catch (error) {
    console.error('[Activity Log Cleanup] ❌ Cleanup job failed:', error);

    // Notify on error if webhook is configured
    if (process.env.CLEANUP_WEBHOOK_URL) {
      try {
        await fetch(process.env.CLEANUP_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'activity_log_cleanup',
            timestamp: new Date().toISOString(),
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          }),
        });
      } catch (err) {
        console.error('[Activity Log Cleanup] Error sending error webhook:', err);
      }
    }
  }
}

/**
 * Schedule the cleanup job to run daily at 2 AM UTC
 */
export function startActivityLogCleanupJob(): void {
  if (cleanupTimer) {
    console.log('[Activity Log Cleanup] Job already running, skipping initialization');
    return;
  }

  const delayMs = getMillisecondsUntilNextCleanup();
  const nextRun = new Date(Date.now() + delayMs);

  console.log(
    `[Activity Log Cleanup] Job scheduled to run at ${nextRun.toISOString()} (in ${Math.round(delayMs / 1000 / 60)} minutes)`
  );

  // Schedule first run
  cleanupTimer = setTimeout(() => {
    // Execute immediately
    executeCleanup();

    // Schedule to repeat every 24 hours
    cleanupTimer = setInterval(executeCleanup, 24 * 60 * 60 * 1000);
  }, delayMs);
}

/**
 * Stop the cleanup job
 */
export function stopActivityLogCleanupJob(): void {
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    console.log('[Activity Log Cleanup] Job stopped');
  }
}

/**
 * Manually trigger cleanup (for testing or manual execution)
 */
export async function triggerActivityLogCleanup(): Promise<void> {
  console.log('[Activity Log Cleanup] Manual cleanup triggered');
  await executeCleanup();
}
