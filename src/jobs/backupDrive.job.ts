import { GoogleDriveBackupService } from "../services/backup/GoogleDriveBackupService";
import logger from "../core/logger";

let backupInitialTimer: NodeJS.Timeout | null = null;
let backupRecurringTimer: NodeJS.Timeout | null = null;

function getMillisecondsUntilNextRun(hourUTC: number, minuteUTC: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(hourUTC, minuteUTC, 0, 0);

  if (next <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  return next.getTime() - now.getTime();
}

async function executeBackup(): Promise<void> {
  logger.info({
    layer: "job",
    action: "GOOGLE_DRIVE_BACKUP_START",
    payload: { timestamp: new Date().toISOString() },
  });

  try {
    const result = await GoogleDriveBackupService.executeBackup();
    logger.info({
      layer: "job",
      action: "GOOGLE_DRIVE_BACKUP_SUCCESS",
      payload: result,
    });
  } catch (error: any) {
    logger.error({
      layer: "job",
      action: "GOOGLE_DRIVE_BACKUP_FAIL",
      meta: { error: error instanceof Error ? error.message : String(error) },
    });
  }
}

export function startGoogleDriveBackupJob(): void {
  if (backupInitialTimer) clearTimeout(backupInitialTimer);
  if (backupRecurringTimer) clearInterval(backupRecurringTimer);

  // 9:00 AM UTC = 3:00 AM Costa Rica Time (UTC-6)
  const delayMs = getMillisecondsUntilNextRun(9, 0);
  const nextRun = new Date(Date.now() + delayMs);

  logger.info({
    layer: "job",
    action: "GOOGLE_DRIVE_BACKUP_SCHEDULED",
    payload: {
      nextRun: nextRun.toISOString(),
      delayMinutes: Math.round(delayMs / 1000 / 60),
      schedule: "Daily at 3:00 AM Costa Rica (9:00 AM UTC)",
    },
  });

  backupInitialTimer = setTimeout(() => {
    executeBackup();
    backupInitialTimer = null;
    backupRecurringTimer = setInterval(executeBackup, 24 * 60 * 60 * 1000);
  }, delayMs);
}

export function stopGoogleDriveBackupJob(): void {
  if (backupInitialTimer) {
    clearTimeout(backupInitialTimer);
    backupInitialTimer = null;
  }
  if (backupRecurringTimer) {
    clearInterval(backupRecurringTimer);
    backupRecurringTimer = null;
  }

  logger.info({
    layer: "job",
    action: "GOOGLE_DRIVE_BACKUP_STOPPED",
    payload: { message: "Job de respaldo a Google Drive detenido" },
  });
}
