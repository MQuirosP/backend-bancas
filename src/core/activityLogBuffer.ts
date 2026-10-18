import prisma from './prismaClient';
import logger from './logger';
import { ActivityType, Prisma } from '../generated/prisma/client';

export type ActivityLogItem = {
  userId?: string | null;
  bancaId?: string | null;
  action: ActivityType;
  targetType?: string | null;
  targetId?: string | null;
  details?: Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue | null;
  createdAt?: Date;
};

/**
 * ActivityLogBuffer - Acumulador en memoria para inserción masiva (bulk flush) de ActivityLogs.
 *
 * Elimina la contención transaccional y el pool exhaustion derivados de abrir transacciones
 * interactivas individuales por cada log de auditoría durante la emisión de tickets.
 *
 * Características:
 * - Flush por volumen: máximo 250 elementos por lote.
 * - Flush por tiempo: cada 3,000 ms si existen elementos pendientes.
 * - Inserción sin bloqueo mediante prisma.activityLog.createMany({ skipDuplicates: true }).
 * - Drenado seguro en Graceful Shutdown (beforeExit, SIGTERM, SIGINT).
 * - Cero excepciones hacia el hilo principal (Event Loop seguro para 0.5 vCPU).
 */
export class ActivityLogBuffer {
  private static buffer: ActivityLogItem[] = [];
  private static readonly MAX_BATCH_SIZE = 250;
  private static readonly FLUSH_INTERVAL_MS = 3000;
  private static flushTimer: NodeJS.Timeout | null = null;
  private static isFlushing = false;
  private static shutdownRegistered = false;

  static init(): void {
    if (this.shutdownRegistered) return;
    this.shutdownRegistered = true;

    const handleShutdown = async (signal: string) => {
      logger.info({
        layer: 'activity-buffer',
        action: 'SHUTDOWN_FLUSH_START',
        payload: { signal, pendingCount: this.buffer.length },
      });
      await this.flush();
    };

    process.once('beforeExit', () => { handleShutdown('beforeExit'); });
    process.once('SIGTERM', () => { handleShutdown('SIGTERM'); });
    process.once('SIGINT', () => { handleShutdown('SIGINT'); });
  }

  /**
   * Encola un log en el buffer de memoria (operación sincrónica O(1) de < 0.05 ms).
   */
  static push(item: ActivityLogItem): void {
    this.init();

    this.buffer.push({
      ...item,
      createdAt: item.createdAt || new Date(),
    });

    // Disparo por tamaño
    if (this.buffer.length >= this.MAX_BATCH_SIZE) {
      this.flush().catch((err: any) => {
        logger.error({
          layer: 'activity-buffer',
          action: 'ASYNC_FLUSH_TRIGGER_ERROR',
          meta: { error: err?.message || String(err) },
        });
      });
      return;
    }

    // Disparo por tiempo
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush().catch((err: any) => {
          logger.error({
            layer: 'activity-buffer',
            action: 'TIMER_FLUSH_TRIGGER_ERROR',
            meta: { error: err?.message || String(err) },
          });
        });
      }, this.FLUSH_INTERVAL_MS);
      this.flushTimer.unref();
    }
  }

  /**
   * Vacía el buffer hacia PostgreSQL en lotes de hasta MAX_BATCH_SIZE tuplas.
   */
  static async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.buffer.length === 0 || this.isFlushing) {
      return;
    }

    this.isFlushing = true;
    try {
      while (this.buffer.length > 0) {
        const batch = this.buffer.splice(0, this.MAX_BATCH_SIZE);
        if (batch.length === 0) break;

        const mappedBatch = batch.map((item) => ({
          userId: item.userId || null,
          bancaId: item.bancaId || null,
          action: item.action,
          targetType: item.targetType || null,
          targetId: item.targetId || null,
          details: item.details === undefined ? undefined : item.details === null ? Prisma.JsonNull : item.details,
          createdAt: item.createdAt || new Date(),
        }));

        await prisma.activityLog.createMany({
          data: mappedBatch,
          skipDuplicates: true,
        });

        logger.debug({
          layer: 'activity-buffer',
          action: 'BATCH_FLUSH_SUCCESS',
          payload: { count: mappedBatch.length, remainingInBuffer: this.buffer.length },
        });
      }
    } catch (err: any) {
      logger.error({
        layer: 'activity-buffer',
        action: 'BATCH_FLUSH_ERROR',
        meta: { error: err?.message || String(err) },
      });
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Retorna la cantidad de elementos pendientes en memoria (utilizado para monitoreo o tests).
   */
  static getPendingCount(): number {
    return this.buffer.length;
  }
}
