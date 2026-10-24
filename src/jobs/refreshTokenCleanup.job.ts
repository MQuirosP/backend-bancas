/**
 * Refresh Token Cleanup Job
 *
 * Automatically purges expired and revoked refresh tokens older than 15 days.
 * Prevents index bloat and unneeded storage accumulation in PostgreSQL.
 *
 * Schedule: Runs daily at 3:30 AM UTC (9:30 PM CR)
 * Retention: 15 days after expiration or revocation
 */

import prisma from '../core/prismaClient';
import { warmupConnection } from '../core/connectionWarmup';
import logger from '../core/logger';
import { runAsGlobalJob } from '../core/tenantContext';
import { withConnectionRetry } from '../core/withConnectionRetry';

let cleanupTimer: NodeJS.Timeout | null = null;

function getMillisecondsUntilNextRun(): number {
  const now = new Date();
  const next = new Date(now);

  // Programar a las 3:30 AM UTC
  next.setUTCHours(3, 30, 0, 0);

  if (next <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  return next.getTime() - now.getTime();
}

export async function executeRefreshTokenCleanup(): Promise<{ deletedCount: number }> {
  return runAsGlobalJob(async () => {
    const RETENTION_DAYS = 15;
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

    try {
      const isReady = await warmupConnection({ useDirect: false, context: 'refreshTokenCleanup' });
      if (!isReady) {
        logger.warn({
          layer: 'job',
          action: 'REFRESH_TOKEN_CLEANUP_WARMUP_FAILED',
          payload: { message: 'Connection warmup failed, skipping refresh token cleanup' }
        });
        return { deletedCount: 0 };
      }

      logger.info({
        layer: 'job',
        action: 'REFRESH_TOKEN_CLEANUP_START',
        payload: { cutoff: cutoff.toISOString(), retentionDays: RETENTION_DAYS }
      });

      const result = await withConnectionRetry(
        () => prisma.refreshToken.deleteMany({
          where: {
            OR: [
              { expiresAt: { lt: cutoff } },
              { AND: [{ revoked: true }, { revokedAt: { lt: cutoff } }] }
            ]
          }
        }),
        { context: 'refreshTokenCleanup.deleteMany', maxRetries: 2 }
      );

      logger.info({
        layer: 'job',
        action: 'REFRESH_TOKEN_CLEANUP_SUCCESS',
        payload: { deletedCount: result.count }
      });

      return { deletedCount: result.count };
    } catch (error: any) {
      logger.error({
        layer: 'job',
        action: 'REFRESH_TOKEN_CLEANUP_ERROR',
        meta: { error: error?.message || String(error) }
      });
      return { deletedCount: 0 };
    }
  });
}

export function startRefreshTokenCleanupJob(): void {
  if (cleanupTimer) {
    return;
  }

  const delayMs = getMillisecondsUntilNextRun();
  const nextRun = new Date(Date.now() + delayMs);

  logger.info({
    layer: 'job',
    action: 'REFRESH_TOKEN_CLEANUP_JOB_SCHEDULED',
    payload: { nextRun: nextRun.toISOString(), delayMinutes: Math.round(delayMs / 1000 / 60) }
  });

  cleanupTimer = setTimeout(() => {
    executeRefreshTokenCleanup().catch(() => {});
    cleanupTimer = setInterval(() => {
      executeRefreshTokenCleanup().catch(() => {});
    }, 24 * 60 * 60 * 1000);
  }, delayMs);
}

export function stopRefreshTokenCleanupJob(): void {
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    logger.info({
      layer: 'job',
      action: 'REFRESH_TOKEN_CLEANUP_JOB_STOPPED'
    });
  }
}
