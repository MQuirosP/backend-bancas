// src/api/v1/services/sorteosAuto.service.ts
import prisma from '../../../core/prismaClient';
import { AppError } from '../../../core/errors';
import { SorteoStatus, Prisma } from '@prisma/client';
import logger from '../../../core/logger';
import SorteoService from './sorteo.service';
import LoteriaService from './loteria.service';
import { startOfLocalDay, addLocalDays } from '../../../utils/datetime';
import { withConnectionRetry } from '../../../core/withConnectionRetry';

/**
 * Obtiene o crea la configuración de automatización (singleton)
 *  MEJORADO: Con reintentos automáticos ante errores de conexión con Supabase
 */
async function getOrCreateConfig() {
  //  NUEVO: Reintentos automáticos para errores de conexión (P1001, P1017, etc.)
  // El pooler de Supabase puede tener problemas intermitentes de conectividad
  let config = await withConnectionRetry(
    () => prisma.sorteosAutoConfig.findFirst(),
    {
      maxRetries: 3,
      backoffMinMs: 1000, // 1 segundo inicial
      backoffMaxMs: 5000, // máximo 5 segundos
      context: 'getOrCreateConfig',
    }
  );
  
  if (!config) {
    config = await withConnectionRetry(
      () =>
        prisma.sorteosAutoConfig.create({
      data: {
        autoOpenEnabled: false,
        autoCreateEnabled: false,
      },
        }),
      {
        maxRetries: 3,
        backoffMinMs: 1000,
        backoffMaxMs: 5000,
        context: 'createAutoConfig',
      }
    );
    logger.info({
      layer: 'service',
      action: 'SORTEOS_AUTO_CONFIG_CREATED',
      payload: { configId: config.id },
    });
  }
  
  return config;
}

/**
 * Obtiene el rango del día actual en hora CR (00:00:00 - 23:59:59.999)
 * 
 * IMPORTANTE: Usa hora local de Costa Rica consistentemente.
 * El 'end' es el inicio del día siguiente menos 1ms para incluir todo el día.
 */
function getTodayRangeCR(): { start: Date; end: Date } {
  const now = new Date();
  const start = startOfLocalDay(now);
  // El final del día es el inicio del día siguiente menos 1ms
  // Esto asegura que incluimos todos los sorteos del día hasta 23:59:59.999
  const nextDayStart = addLocalDays(start, 1);
  const end = new Date(nextDayStart.getTime() - 1);
  return { start, end };
}

export const SorteosAutoService = {
  /**
   * Obtiene la configuración actual
   */
  async getConfig() {
    const config = await getOrCreateConfig();
    return {
      autoOpenEnabled: config.autoOpenEnabled,
      autoCreateEnabled: config.autoCreateEnabled,
      autoCloseEnabled: config.autoCloseEnabled,
      openCronSchedule: config.openCronSchedule,
      createCronSchedule: config.createCronSchedule,
      closeCronSchedule: config.closeCronSchedule,
      lastOpenExecution: config.lastOpenExecution,
      lastCreateExecution: config.lastCreateExecution,
      lastCloseExecution: config.lastCloseExecution,
      lastOpenCount: config.lastOpenCount,
      lastCreateCount: config.lastCreateCount,
      lastCloseCount: config.lastCloseCount,
      updatedAt: config.updatedAt,
    };
  },

  /**
   * Actualiza la configuración
   */
  async updateConfig(data: {
    autoOpenEnabled?: boolean;
    autoCreateEnabled?: boolean;
    autoCloseEnabled?: boolean;
    openCronSchedule?: string | null;
    createCronSchedule?: string | null;
    closeCronSchedule?: string | null;
  }, userId: string) {
    const config = await getOrCreateConfig();

    const updated = await prisma.sorteosAutoConfig.update({
      where: { id: config.id },
      data: {
        ...(data.autoOpenEnabled !== undefined && { autoOpenEnabled: data.autoOpenEnabled }),
        ...(data.autoCreateEnabled !== undefined && { autoCreateEnabled: data.autoCreateEnabled }),
        ...(data.autoCloseEnabled !== undefined && { autoCloseEnabled: data.autoCloseEnabled }),
        ...(data.openCronSchedule !== undefined && { openCronSchedule: data.openCronSchedule }),
        ...(data.createCronSchedule !== undefined && { createCronSchedule: data.createCronSchedule }),
        ...(data.closeCronSchedule !== undefined && { closeCronSchedule: data.closeCronSchedule }),
        updatedBy: userId,
      },
    });

    logger.info({
      layer: 'service',
      action: 'SORTEOS_AUTO_CONFIG_UPDATE',
      userId,
      payload: data,
    });

    return {
      autoOpenEnabled: updated.autoOpenEnabled,
      autoCreateEnabled: updated.autoCreateEnabled,
      autoCloseEnabled: updated.autoCloseEnabled,
      openCronSchedule: updated.openCronSchedule,
      createCronSchedule: updated.createCronSchedule,
      closeCronSchedule: updated.closeCronSchedule,
      updatedAt: updated.updatedAt,
    };
  },

  /**
   * Ejecuta la apertura automática de sorteos del día
   */
  async executeAutoOpen(userId: string): Promise<{
    success: boolean;
    openedCount: number;
    errors: Array<{ sorteoId: string; error: string }>;
    executedAt: Date;
  }> {
    const config = await getOrCreateConfig();
    
    if (!config.autoOpenEnabled) {
      logger.info({
        layer: 'service',
        action: 'SORTEOS_AUTO_OPEN_SKIPPED',
        payload: { reason: 'autoOpenEnabled is false' },
      });
      return {
        success: true,
        openedCount: 0,
        errors: [],
        executedAt: new Date(),
      };
    }

    const { start, end } = getTodayRangeCR();
    
    // Buscar sorteos SCHEDULED del día actual (en hora CR)
    const sorteos = await prisma.sorteo.findMany({
      where: {
        status: SorteoStatus.SCHEDULED,
        isActive: true,
        scheduledAt: {
          gte: start,
          lte: end,
        },
      },
      select: {
        id: true,
        name: true,
        scheduledAt: true,
        loteriaId: true,
      },
    });

    logger.info({
      layer: 'service',
      action: 'SORTEOS_AUTO_OPEN_START',
      payload: {
        sorteosFound: sorteos.length,
        dateRange: { start: start.toISOString(), end: end.toISOString() },
      },
    });

    const errors: Array<{ sorteoId: string; error: string }> = [];
    let openedCount = 0;

    for (const sorteo of sorteos) {
      try {
        //  Usar userId del admin autenticado
        await SorteoService.open(sorteo.id, userId);
        openedCount++;
        
        logger.info({
          layer: 'service',
          action: 'SORTEO_AUTO_OPENED',
          payload: { sorteoId: sorteo.id, name: sorteo.name },
        });
      } catch (error: any) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push({ sorteoId: sorteo.id, error: errorMessage });
        
        logger.warn({
          layer: 'service',
          action: 'SORTEO_AUTO_OPEN_ERROR',
          payload: {
            sorteoId: sorteo.id,
            error: errorMessage,
          },
        });
      }
    }

    // Actualizar configuración con última ejecución
    await prisma.sorteosAutoConfig.update({
      where: { id: config.id },
      data: {
        lastOpenExecution: new Date(),
        lastOpenCount: openedCount,
      },
    });

    // Registrar en cron_execution_logs (si existe la tabla)
    try {
      await prisma.$executeRawUnsafe(`
        INSERT INTO cron_execution_logs (id, job_name, status, executed_at, affected_rows, error_message)
        VALUES (
          gen_random_uuid(),
          'sorteos_auto_open',
          ${errors.length === 0 ? "'success'" : "'partial'"},
          NOW(),
          ${openedCount},
          ${errors.length > 0 ? `'${errors.length} errores'` : 'NULL'}
        )
      `);
    } catch (err) {
      // Si la tabla no existe, solo loggear
      logger.debug({
        layer: 'service',
        action: 'SORTEOS_AUTO_OPEN_LOG_SKIPPED',
        payload: { reason: 'cron_execution_logs table may not exist' },
      });
    }

    const executedAt = new Date();
    
    logger.info({
      layer: 'service',
      action: 'SORTEOS_AUTO_OPEN_COMPLETE',
      payload: {
        openedCount,
        errorsCount: errors.length,
        executedAt: executedAt.toISOString(),
      },
    });

    return {
      success: errors.length === 0,
      openedCount,
      errors,
      executedAt,
    };
  },

  /**
   * Ejecuta la creación automática de sorteos futuros
   */
  async executeAutoCreate(daysAhead: number = 7, userId?: string): Promise<{
    success: boolean;
    createdCount: number;
    skippedCount: number;
    errors: Array<{ loteriaId: string; error: string }>;
    executedAt: Date;
  }> {
    const config = await getOrCreateConfig();
    
    if (!config.autoCreateEnabled) {
      logger.info({
        layer: 'service',
        action: 'SORTEOS_AUTO_CREATE_SKIPPED',
        payload: { reason: 'autoCreateEnabled is false' },
      });
      return {
        success: true,
        createdCount: 0,
        skippedCount: 0,
        errors: [],
        executedAt: new Date(),
      };
    }

    // Buscar loterías activas con reglas configuradas
    const loterias = await prisma.loteria.findMany({
      where: {
        isActive: true,
        rulesJson: {
          not: Prisma.JsonNull,
        },
      },
      select: {
        id: true,
        name: true,
        rulesJson: true,
      },
    });

    logger.info({
      layer: 'service',
      action: 'SORTEOS_AUTO_CREATE_START',
      payload: {
        loteriasFound: loterias.length,
        daysAhead,
      },
    });

    const errors: Array<{ loteriaId: string; error: string }> = [];
    let totalCreated = 0;
    let totalSkipped = 0;

    const today = startOfLocalDay(new Date());
    const minDaysAhead = 3; // Mínimo de días futuros que deben existir
    
    for (const loteria of loterias) {
      try {
        const rules = loteria.rulesJson as any;
        
        // Verificar si tiene drawSchedule configurado
        const schedule = rules?.drawSchedule;
        if (!schedule || !schedule.times || schedule.times.length === 0) {
          logger.debug({
            layer: 'service',
            action: 'SORTEOS_AUTO_CREATE_SKIP_LOTERIA',
            payload: {
              loteriaId: loteria.id,
              reason: 'No tiene drawSchedule configurado',
            },
          });
          continue;
        }

        // Verificar flag autoCreateSorteos
        if (rules?.autoCreateSorteos === false) {
          logger.debug({
            layer: 'service',
            action: 'SORTEOS_AUTO_CREATE_SKIP_LOTERIA',
            payload: {
              loteriaId: loteria.id,
              reason: 'autoCreateSorteos is false',
            },
          });
          continue;
        }

        // Verificar cuál es el último sorteo futuro para esta lotería
        const lastSorteo = await prisma.sorteo.findFirst({
          where: {
            loteriaId: loteria.id,
            isActive: true,
            scheduledAt: { gte: today },
          },
          orderBy: {
            scheduledAt: 'desc',
          },
          select: {
            scheduledAt: true,
          },
        });

        // Determinar desde dónde generar sorteos
        let startDate: Date;
        let actualDaysAhead: number;

        if (!lastSorteo) {
          // No hay sorteos futuros, generar desde hoy
          startDate = today;
          actualDaysAhead = daysAhead;
          
          logger.info({
            layer: 'service',
            action: 'SORTEOS_AUTO_CREATE_NO_FUTURE',
            payload: {
              loteriaId: loteria.id,
              startDate: startDate.toISOString(),
              daysAhead: actualDaysAhead,
            },
          });
        } else {
          const lastSorteoDate = startOfLocalDay(lastSorteo.scheduledAt);
          const daysUntilLast = Math.ceil(
            (lastSorteoDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)
          );

          if (daysUntilLast < minDaysAhead) {
            // El último sorteo está muy cerca, generar desde el día siguiente al último
            startDate = addLocalDays(lastSorteoDate, 1);
            // Generar suficientes días para tener al menos minDaysAhead + daysAhead días futuros
            actualDaysAhead = Math.max(daysAhead, minDaysAhead - daysUntilLast + daysAhead);
            
            logger.info({
              layer: 'service',
              action: 'SORTEOS_AUTO_CREATE_EXTEND',
              payload: {
                loteriaId: loteria.id,
                lastSorteoDate: lastSorteoDate.toISOString(),
                daysUntilLast,
                startDate: startDate.toISOString(),
                daysAhead: actualDaysAhead,
              },
            });
          } else {
            // Ya hay suficientes sorteos futuros, no generar nada
            logger.info({
              layer: 'service',
              action: 'SORTEOS_AUTO_CREATE_SKIP_SUFFICIENT',
              payload: {
                loteriaId: loteria.id,
                lastSorteoDate: lastSorteoDate.toISOString(),
                daysUntilLast,
                minDaysAhead,
              },
            });
            continue;
          }
        }

        // Crear sorteos usando el servicio existente
        // forceCreate = false para respetar la bandera autoCreateSorteos en autogeneración automática
        const result = await LoteriaService.seedSorteosFromRules(
          loteria.id,
          startDate,
          actualDaysAhead,
          false, // dryRun = false
          undefined, // scheduledDates = undefined (generar todos)
          false // forceCreate = false (respetar autoCreateSorteos)
        );

        // Manejar diferentes tipos de retorno (puede ser number o string[])
        const createdCount = Array.isArray(result.created) 
          ? result.created.length 
          : (typeof result.created === 'number' ? result.created : 0);
        const skippedCount = Array.isArray(result.skipped) 
          ? result.skipped.length 
          : (typeof result.skipped === 'number' ? result.skipped : 0);

        totalCreated += createdCount;
        totalSkipped += skippedCount;

        logger.info({
          layer: 'service',
          action: 'SORTEOS_AUTO_CREATE_LOTERIA_SUCCESS',
          payload: {
            loteriaId: loteria.id,
            created: createdCount,
            skipped: skippedCount,
          },
        });
      } catch (error: any) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push({ loteriaId: loteria.id, error: errorMessage });
        
        logger.error({
          layer: 'service',
          action: 'SORTEOS_AUTO_CREATE_LOTERIA_ERROR',
          payload: {
            loteriaId: loteria.id,
            error: errorMessage,
          },
        });
      }
    }

    // Actualizar configuración con última ejecución
    await prisma.sorteosAutoConfig.update({
      where: { id: config.id },
      data: {
        lastCreateExecution: new Date(),
        lastCreateCount: totalCreated,
      },
    });

    // Registrar en cron_execution_logs (si existe la tabla)
    try {
      await prisma.$executeRawUnsafe(`
        INSERT INTO cron_execution_logs (id, job_name, status, executed_at, affected_rows, error_message)
        VALUES (
          gen_random_uuid(),
          'sorteos_auto_create',
          ${errors.length === 0 ? "'success'" : "'partial'"},
          NOW(),
          ${totalCreated},
          ${errors.length > 0 ? `'${errors.length} errores'` : 'NULL'}
        )
      `);
    } catch (err) {
      logger.debug({
        layer: 'service',
        action: 'SORTEOS_AUTO_CREATE_LOG_SKIPPED',
        payload: { reason: 'cron_execution_logs table may not exist' },
      });
    }

    const executedAt = new Date();
    
    logger.info({
      layer: 'service',
      action: 'SORTEOS_AUTO_CREATE_COMPLETE',
      payload: {
        createdCount: totalCreated,
        skippedCount: totalSkipped,
        errorsCount: errors.length,
        executedAt: executedAt.toISOString(),
      },
    });

    return {
      success: errors.length === 0,
      createdCount: totalCreated,
      skippedCount: totalSkipped,
      errors,
      executedAt,
    };
  },

  /**
   * Ejecuta el cierre automático de sorteos sin ventas
   *
   * Cierra automáticamente sorteos que cumplen TODAS estas condiciones:
   * - Estado: SCHEDULED u OPEN
   * - scheduledAt hace más de 5 minutos
   * - 0 tickets vendidos (incluyendo anulados)
   * - isActive = true
   * - deletedAt IS NULL
   */
  async executeAutoClose(userId: string): Promise<{
    success: boolean;
    closedCount: number;
    errors: Array<{ sorteoId: string; sorteoName: string; error: string }>;
    executedAt: Date;
  }> {
    const config = await getOrCreateConfig();

    if (!config.autoCloseEnabled) {
      logger.info({
        layer: 'service',
        action: 'SORTEOS_AUTO_CLOSE_SKIPPED',
        payload: { reason: 'autoCloseEnabled is false' },
      });
      return {
        success: true,
        closedCount: 0,
        errors: [],
        executedAt: new Date(),
      };
    }

    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

    //  MEJORADO: Buscar sorteos candidatos con reintentos ante errores de conexión
    // Buscar sorteos candidatos: SCHEDULED u OPEN hace más de 5 minutos
    const candidates = await withConnectionRetry(
      () =>
        prisma.sorteo.findMany({
      where: {
        status: {
          in: [SorteoStatus.SCHEDULED, SorteoStatus.OPEN],
        },
        isActive: true,
        deletedAt: null,
        scheduledAt: {
          lte: fiveMinutesAgo,
        },
      },
      select: {
        id: true,
        name: true,
        scheduledAt: true,
        status: true,
        _count: {
          select: {
            tickets: true, // Cuenta todos los tickets (activos + anulados)
          },
        },
      },
        }),
      {
        maxRetries: 3,
        backoffMinMs: 1000,
        backoffMaxMs: 5000,
        context: 'findSorteosToClose',
      }
    );

    logger.info({
      layer: 'service',
      action: 'SORTEOS_AUTO_CLOSE_START',
      payload: {
        candidatesFound: candidates.length,
        cutoffTime: fiveMinutesAgo.toISOString(),
      },
    });

    // Filtrar solo los que tienen 0 tickets
    const sorteosToClose = candidates.filter(s => s._count.tickets === 0);

    logger.info({
      layer: 'service',
      action: 'SORTEOS_AUTO_CLOSE_FILTERED',
      payload: {
        totalCandidates: candidates.length,
        sorteosWithoutSales: sorteosToClose.length,
        sorteosWithSales: candidates.length - sorteosToClose.length,
      },
    });

    const errors: Array<{ sorteoId: string; sorteoName: string; error: string }> = [];
    let closedCount = 0;

    for (const sorteo of sorteosToClose) {
      try {
        //  Para sorteos SCHEDULED, cambiar directamente a CLOSED sin usar SorteoService.close()
        // (que solo acepta OPEN/EVALUATED)
        if (sorteo.status === SorteoStatus.SCHEDULED) {
          //  MEJORADO: Reintentos ante errores de conexión
          await withConnectionRetry(
            () =>
              prisma.sorteo.update({
            where: { id: sorteo.id },
            data: {
              status: SorteoStatus.CLOSED,
              updatedAt: new Date(),
            },
              }),
            {
              maxRetries: 2, // Menos reintentos para operaciones individuales
              backoffMinMs: 500,
              backoffMaxMs: 2000,
              context: `closeSorteo-${sorteo.id}`,
            }
          );
          closedCount++;

          logger.info({
            layer: 'service',
            action: 'SORTEO_AUTO_CLOSED',
            payload: {
              sorteoId: sorteo.id,
              name: sorteo.name,
              scheduledAt: sorteo.scheduledAt.toISOString(),
              previousStatus: 'SCHEDULED',
              method: 'direct_update',
            },
          });
        } else {
          // Para sorteos OPEN, usar el servicio normal
          await SorteoService.close(sorteo.id, userId);
          closedCount++;

          logger.info({
            layer: 'service',
            action: 'SORTEO_AUTO_CLOSED',
            payload: {
              sorteoId: sorteo.id,
              name: sorteo.name,
              scheduledAt: sorteo.scheduledAt.toISOString(),
              previousStatus: 'OPEN',
              method: 'service',
            },
          });
        }
      } catch (error: any) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push({
          sorteoId: sorteo.id,
          sorteoName: sorteo.name,
          error: errorMessage,
        });

        logger.warn({
          layer: 'service',
          action: 'SORTEO_AUTO_CLOSE_ERROR',
          payload: {
            sorteoId: sorteo.id,
            sorteoName: sorteo.name,
            error: errorMessage,
          },
        });
      }
    }

    //  MEJORADO: Actualizar configuración con última ejecución (con reintentos)
    await withConnectionRetry(
      () =>
        prisma.sorteosAutoConfig.update({
      where: { id: config.id },
      data: {
        lastCloseExecution: new Date(),
        lastCloseCount: closedCount,
      },
        }),
      {
        maxRetries: 3,
        backoffMinMs: 1000,
        backoffMaxMs: 5000,
        context: 'updateAutoCloseConfig',
      }
    );

    // Registrar en cron_execution_logs (si existe la tabla)
    try {
      await prisma.$executeRawUnsafe(`
        INSERT INTO cron_execution_logs (id, job_name, status, executed_at, affected_rows, error_message)
        VALUES (
          gen_random_uuid(),
          'sorteos_auto_close',
          ${errors.length === 0 ? "'success'" : (closedCount > 0 ? "'partial'" : "'error'")},
          NOW(),
          ${closedCount},
          ${errors.length > 0 ? `'${errors.length} errores'` : 'NULL'}
        )
      `);
    } catch (err) {
      // Si la tabla no existe, solo loggear
      logger.debug({
        layer: 'service',
        action: 'SORTEOS_AUTO_CLOSE_LOG_SKIPPED',
        payload: { reason: 'cron_execution_logs table may not exist' },
      });
    }

    const executedAt = new Date();

    logger.info({
      layer: 'service',
      action: 'SORTEOS_AUTO_CLOSE_COMPLETE',
      payload: {
        closedCount,
        errorsCount: errors.length,
        executedAt: executedAt.toISOString(),
      },
    });

    return {
      success: errors.length === 0 && closedCount === sorteosToClose.length,
      closedCount,
      errors,
      executedAt,
    };
  },

  /**
   * Obtiene el estado de salud de los cron jobs
   */
  async getHealthStatus() {
    const config = await getOrCreateConfig();
    
    // Intentar obtener logs de cron_execution_logs
    let openStatus: any = null;
    let createStatus: any = null;

    try {
      const openLogs = await prisma.$queryRawUnsafe<Array<{
        executed_at: Date;
        status: string;
        affected_rows: number | null;
      }>>(`
        SELECT executed_at, status, affected_rows
        FROM cron_execution_logs
        WHERE job_name = 'sorteos_auto_open'
        ORDER BY executed_at DESC
        LIMIT 1
      `);

      if (openLogs && openLogs.length > 0) {
        const log = openLogs[0];
        const hoursSince = (Date.now() - new Date(log.executed_at).getTime()) / (1000 * 60 * 60);
        openStatus = {
          isHealthy: hoursSince < 25, // Debe ejecutarse diariamente
          lastExecution: log.executed_at,
          hoursSinceLastRun: Math.round(hoursSince * 100) / 100,
          lastExecutionCount: log.affected_rows,
          status: log.status,
        };
      }
    } catch (err) {
      // Tabla puede no existir
    }

    try {
      const createLogs = await prisma.$queryRawUnsafe<Array<{
        executed_at: Date;
        status: string;
        affected_rows: number | null;
      }>>(`
        SELECT executed_at, status, affected_rows
        FROM cron_execution_logs
        WHERE job_name = 'sorteos_auto_create'
        ORDER BY executed_at DESC
        LIMIT 1
      `);

      if (createLogs && createLogs.length > 0) {
        const log = createLogs[0];
        const hoursSince = (Date.now() - new Date(log.executed_at).getTime()) / (1000 * 60 * 60);
        createStatus = {
          isHealthy: hoursSince < 25, // Debe ejecutarse diariamente
          lastExecution: log.executed_at,
          hoursSinceLastRun: Math.round(hoursSince * 100) / 100,
          lastExecutionCount: log.affected_rows,
          status: log.status,
        };
      }
    } catch (err) {
      // Tabla puede no existir
    }

    // Si no hay logs, usar configuración
    if (!openStatus && config.lastOpenExecution) {
      const hoursSince = (Date.now() - config.lastOpenExecution.getTime()) / (1000 * 60 * 60);
      openStatus = {
        isHealthy: hoursSince < 25,
        lastExecution: config.lastOpenExecution,
        hoursSinceLastRun: Math.round(hoursSince * 100) / 100,
        lastExecutionCount: config.lastOpenCount,
        status: 'unknown',
      };
    }

    if (!createStatus && config.lastCreateExecution) {
      const hoursSince = (Date.now() - config.lastCreateExecution.getTime()) / (1000 * 60 * 60);
      createStatus = {
        isHealthy: hoursSince < 25,
        lastExecution: config.lastCreateExecution,
        hoursSinceLastRun: Math.round(hoursSince * 100) / 100,
        lastExecutionCount: config.lastCreateCount,
        status: 'unknown',
      };
    }

    //  NUEVO: Obtener status de auto-close
    let closeStatus: any = null;

    try {
      const closeLogs = await prisma.$queryRawUnsafe<Array<{
        executed_at: Date;
        status: string;
        affected_rows: number | null;
      }>>(`
        SELECT executed_at, status, affected_rows
        FROM cron_execution_logs
        WHERE job_name = 'sorteos_auto_close'
        ORDER BY executed_at DESC
        LIMIT 1
      `);

      if (closeLogs && closeLogs.length > 0) {
        const log = closeLogs[0];
        const hoursSince = (Date.now() - new Date(log.executed_at).getTime()) / (1000 * 60 * 60);
        closeStatus = {
          isHealthy: hoursSince < 2, // Debe ejecutarse cada 10 minutos (threshold: 2 horas)
          lastExecution: log.executed_at,
          hoursSinceLastRun: Math.round(hoursSince * 100) / 100,
          lastExecutionCount: log.affected_rows,
          status: log.status,
        };
      }
    } catch (err) {
      // Tabla puede no existir
    }

    // Si no hay logs, usar configuración
    if (!closeStatus && config.lastCloseExecution) {
      const hoursSince = (Date.now() - config.lastCloseExecution.getTime()) / (1000 * 60 * 60);
      closeStatus = {
        isHealthy: hoursSince < 2,
        lastExecution: config.lastCloseExecution,
        hoursSinceLastRun: Math.round(hoursSince * 100) / 100,
        lastExecutionCount: config.lastCloseCount,
        status: 'unknown',
      };
    }

    return {
      open: openStatus || {
        isHealthy: false,
        lastExecution: null,
        hoursSinceLastRun: null,
        lastExecutionCount: null,
        status: 'never_run',
      },
      create: createStatus || {
        isHealthy: false,
        lastExecution: null,
        hoursSinceLastRun: null,
        lastExecutionCount: null,
        status: 'never_run',
      },
      close: closeStatus || {
        isHealthy: false,
        lastExecution: null,
        hoursSinceLastRun: null,
        lastExecutionCount: null,
        status: 'never_run',
      },
      config: {
        autoOpenEnabled: config.autoOpenEnabled,
        autoCreateEnabled: config.autoCreateEnabled,
        autoCloseEnabled: config.autoCloseEnabled,
      },
    };
  },
};

export default SorteosAutoService;

