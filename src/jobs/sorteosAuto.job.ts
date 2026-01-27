/**
 * Sorteos Auto Jobs
 *
 * Jobs para automatización de sorteos:
 * - Auto Open: Abre sorteos SCHEDULED del día
 * - Auto Create: Crea sorteos futuros según reglas
 *
 * Usage:
 *   - Importar en main app file
 *   - Llamar startSorteosAutoJobs() para inicializar
 *
 * Schedule:
 *   - Auto Open: Diariamente a las 7:00 AM UTC (1:00 AM CR)
 *   - Auto Create: Diariamente a las 7:30 AM UTC (1:30 AM CR)
 *
 * NOTA: Estos jobs verifican la configuración antes de ejecutar.
 * Si autoOpenEnabled/autoCreateEnabled están en false, no ejecutan.
 */

import SorteosAutoService from '../api/v1/services/sorteosAuto.service';
import logger from '../core/logger';
import { warmupConnection } from '../core/connectionWarmup';

// Timers separados para timeout inicial y interval recurrente
let openInitialTimer: NodeJS.Timeout | null = null;
let openRecurringTimer: NodeJS.Timeout | null = null;
let createInitialTimer: NodeJS.Timeout | null = null;
let createRecurringTimer: NodeJS.Timeout | null = null;
let closeTimer: NodeJS.Timeout | null = null;

/**
 * Calcula milisegundos hasta la próxima hora específica en UTC
 */
function getMillisecondsUntilNextRun(hour: number, minute: number): number {
  const now = new Date();
  const next = new Date(now);

  // Establecer hora UTC
  next.setUTCHours(hour, minute, 0, 0);

  // Si la hora ya pasó hoy, programar para mañana
  if (next <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  return next.getTime() - now.getTime();
}

/**
 * Ejecuta la apertura automática de sorteos
 */
async function executeAutoOpen(): Promise<void> {
  try {
    logger.info({
      layer: 'job',
      action: 'SORTEOS_AUTO_OPEN_START',
      payload: { timestamp: new Date().toISOString() },
    });

    // Warmup de conexión antes de ejecutar (usa DIRECT_URL para evitar cold starts)
    const isReady = await warmupConnection({ useDirect: true, context: 'autoOpen' });
    if (!isReady) {
      logger.error({
        layer: 'job',
        action: 'SORTEOS_AUTO_OPEN_SKIP',
        payload: { reason: 'Connection warmup failed after retries' },
      });
      return;
    }

    //  Pasar null para jobs cron (sin usuario autenticado)
    // La actividad se registrará con userId: null
    const result = await SorteosAutoService.executeAutoOpen(null as any);

    logger.info({
      layer: 'job',
      action: 'SORTEOS_AUTO_OPEN_COMPLETE',
      payload: {
        success: result.success,
        openedCount: result.openedCount,
        errorsCount: result.errors.length,
        executedAt: result.executedAt.toISOString(),
      },
    });

    if (result.errors.length > 0) {
      logger.warn({
        layer: 'job',
        action: 'SORTEOS_AUTO_OPEN_ERRORS',
        payload: {
          errors: result.errors,
        },
      });
    }
  } catch (error: any) {
    logger.error({
      layer: 'job',
      action: 'SORTEOS_AUTO_OPEN_FAIL',
      payload: {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
  }
}

/**
 * Ejecuta la creación automática de sorteos
 */
async function executeAutoCreate(): Promise<void> {
  try {
    logger.info({
      layer: 'job',
      action: 'SORTEOS_AUTO_CREATE_START',
      payload: { timestamp: new Date().toISOString() },
    });

    // Warmup de conexión antes de ejecutar (usa DIRECT_URL para evitar cold starts)
    const isReady = await warmupConnection({ useDirect: true, context: 'autoCreate' });
    if (!isReady) {
      logger.error({
        layer: 'job',
        action: 'SORTEOS_AUTO_CREATE_SKIP',
        payload: { reason: 'Connection warmup failed after retries' },
      });
      return;
    }

    //  Pasar null para jobs cron (sin usuario autenticado)
    const result = await SorteosAutoService.executeAutoCreate(7, null as any); // 7 días por defecto

    logger.info({
      layer: 'job',
      action: 'SORTEOS_AUTO_CREATE_COMPLETE',
      payload: {
        success: result.success,
        createdCount: result.createdCount,
        skippedCount: result.skippedCount,
        errorsCount: result.errors.length,
        executedAt: result.executedAt.toISOString(),
      },
    });

    if (result.errors.length > 0) {
      logger.warn({
        layer: 'job',
        action: 'SORTEOS_AUTO_CREATE_ERRORS',
        payload: {
          errors: result.errors,
        },
      });
    }
  } catch (error: any) {
    logger.error({
      layer: 'job',
      action: 'SORTEOS_AUTO_CREATE_FAIL',
      payload: {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
  }
}

/**
 * Programa el job de apertura automática
 */
function scheduleAutoOpen(): void {
  // Limpiar timers previos si existen
  if (openInitialTimer) {
    clearTimeout(openInitialTimer);
    openInitialTimer = null;
  }
  if (openRecurringTimer) {
    clearInterval(openRecurringTimer);
    openRecurringTimer = null;
  }

  const delayMs = getMillisecondsUntilNextRun(7, 0); // 7:00 AM UTC = 1:00 AM CR
  const nextRun = new Date(Date.now() + delayMs);

  logger.info({
    layer: 'job',
    action: 'SORTEOS_AUTO_OPEN_SCHEDULED',
    payload: {
      nextRun: nextRun.toISOString(),
      delayMinutes: Math.round(delayMs / 1000 / 60),
    },
  });

  // Programar primera ejecución
  openInitialTimer = setTimeout(() => {
    executeAutoOpen();
    openInitialTimer = null; // Limpiar referencia del timeout ya ejecutado

    // Programar para repetir cada 24 horas
    openRecurringTimer = setInterval(executeAutoOpen, 24 * 60 * 60 * 1000);
  }, delayMs);
}

/**
 * Programa el job de creación automática
 */
function scheduleAutoCreate(): void {
  // Limpiar timers previos si existen
  if (createInitialTimer) {
    clearTimeout(createInitialTimer);
    createInitialTimer = null;
  }
  if (createRecurringTimer) {
    clearInterval(createRecurringTimer);
    createRecurringTimer = null;
  }

  const delayMs = getMillisecondsUntilNextRun(7, 30); // 7:30 AM UTC = 1:30 AM CR
  const nextRun = new Date(Date.now() + delayMs);

  logger.info({
    layer: 'job',
    action: 'SORTEOS_AUTO_CREATE_SCHEDULED',
    payload: {
      nextRun: nextRun.toISOString(),
      delayMinutes: Math.round(delayMs / 1000 / 60),
    },
  });

  // Programar primera ejecución
  createInitialTimer = setTimeout(() => {
    executeAutoCreate();
    createInitialTimer = null; // Limpiar referencia del timeout ya ejecutado

    // Programar para repetir cada 24 horas
    createRecurringTimer = setInterval(executeAutoCreate, 24 * 60 * 60 * 1000);
  }, delayMs);
}

/**
 * Inicia los jobs de automatización de sorteos
 */
export function startSorteosAutoJobs(): void {
  logger.info({
    layer: 'job',
    action: 'SORTEOS_AUTO_JOBS_INIT',
    payload: { message: 'Inicializando jobs de automatización de sorteos' },
  });

  scheduleAutoOpen();
  scheduleAutoCreate();
  startAutoCloseJob();
}

/**
 * Detiene los jobs de automatización de sorteos
 */
export function stopSorteosAutoJobs(): void {
  // Limpiar timers de Auto Open
  if (openInitialTimer) {
    clearTimeout(openInitialTimer);
    openInitialTimer = null;
  }
  if (openRecurringTimer) {
    clearInterval(openRecurringTimer);
    openRecurringTimer = null;
  }

  // Limpiar timers de Auto Create
  if (createInitialTimer) {
    clearTimeout(createInitialTimer);
    createInitialTimer = null;
  }
  if (createRecurringTimer) {
    clearInterval(createRecurringTimer);
    createRecurringTimer = null;
  }

  // Detener Auto Close
  stopAutoCloseJob();

  logger.info({
    layer: 'job',
    action: 'SORTEOS_AUTO_JOBS_STOPPED',
    payload: { message: 'Jobs de automatización de sorteos detenidos' },
  });
}

/**
 * Ejecuta apertura manualmente (para testing)
 */
export async function triggerAutoOpen(): Promise<void> {
  logger.info({
    layer: 'job',
    action: 'SORTEOS_AUTO_OPEN_MANUAL_TRIGGER',
    payload: { message: 'Ejecución manual de apertura automática' },
  });
  await executeAutoOpen();
}

/**
 * Ejecuta creación manualmente (para testing)
 */
export async function triggerAutoCreate(daysAhead: number = 7): Promise<void> {
  logger.info({
    layer: 'job',
    action: 'SORTEOS_AUTO_CREATE_MANUAL_TRIGGER',
    payload: { message: 'Ejecución manual de creación automática', daysAhead },
  });
  await executeAutoCreate();
}

/**
 * Ejecuta el cierre automático de sorteos sin ventas
 */
async function executeAutoClose(): Promise<void> {
  try {
    logger.info({
      layer: 'job',
      action: 'SORTEOS_AUTO_CLOSE_START',
      payload: { timestamp: new Date().toISOString() },
    });

    // Warmup de conexión antes de ejecutar (usa DIRECT_URL para evitar cold starts)
    const isReady = await warmupConnection({ useDirect: true, context: 'autoClose' });
    if (!isReady) {
      logger.error({
        layer: 'job',
        action: 'SORTEOS_AUTO_CLOSE_SKIP',
        payload: { reason: 'Connection warmup failed after retries' },
      });
      return;
    }

    //  Pasar null para jobs cron (sin usuario autenticado)
    const result = await SorteosAutoService.executeAutoClose(null as any);

    logger.info({
      layer: 'job',
      action: 'SORTEOS_AUTO_CLOSE_COMPLETE',
      payload: {
        success: result.success,
        closedCount: result.closedCount,
        errorsCount: result.errors.length,
        executedAt: result.executedAt.toISOString(),
      },
    });

    if (result.errors.length > 0) {
      logger.warn({
        layer: 'job',
        action: 'SORTEOS_AUTO_CLOSE_ERRORS',
        payload: {
          errors: result.errors,
        },
      });
    }
  } catch (error: any) {
    logger.error({
      layer: 'job',
      action: 'SORTEOS_AUTO_CLOSE_FAIL',
      payload: {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
  }
}

/**
 * Inicia el job de cierre automático (cada 10 minutos)
 */
function startAutoCloseJob(): void {
  // Verificar si ya hay un timer activo
  if (closeTimer) {
    logger.warn({
      layer: 'job',
      action: 'SORTEOS_AUTO_CLOSE_ALREADY_RUNNING',
      payload: {
        message: 'Job de cierre automático ya está ejecutándose, omitiendo inicialización',
      },
    });
    return;
  }

  logger.info({
    layer: 'job',
    action: 'SORTEOS_AUTO_CLOSE_SCHEDULED',
    payload: {
      interval: '10 minutes',
      message: 'Iniciando job de cierre automático',
    },
  });

  // Ejecutar inmediatamente al iniciar
  executeAutoClose();

  // Programar para repetir cada 10 minutos
  closeTimer = setInterval(executeAutoClose, 10 * 60 * 1000);
}

/**
 * Detiene el job de cierre automático
 */
function stopAutoCloseJob(): void {
  if (closeTimer) {
    clearInterval(closeTimer);
    closeTimer = null;
  }

  logger.info({
    layer: 'job',
    action: 'SORTEOS_AUTO_CLOSE_STOPPED',
    payload: { message: 'Job de cierre automático detenido' },
  });
}

/**
 * Ejecuta cierre manualmente (para testing)
 */
export async function triggerAutoClose(): Promise<void> {
  logger.info({
    layer: 'job',
    action: 'SORTEOS_AUTO_CLOSE_MANUAL_TRIGGER',
    payload: { message: 'Ejecución manual de cierre automático' },
  });
  await executeAutoClose();
}

