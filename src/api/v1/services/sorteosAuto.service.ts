// src/api/v1/services/sorteosAuto.service.ts
import prisma from '../../../core/prismaClient';
import { AppError } from '../../../core/errors';
import { SorteoStatus, Prisma } from '../../../generated/prisma/client';
import logger from '../../../core/logger';
import SorteoService from './sorteo.service';
import LoteriaService from './loteria.service';
import { tz } from '../../../utils/timezone';
import { withConnectionRetry } from '../../../core/withConnectionRetry';
import { ActivityService } from '../../../core/activity.service';

/**
 * Obtiene o crea la configuraciÃ³n de automatizaciÃ³n (singleton)
 *  MEJORADO: Con reintentos automÃ¡ticos ante errores de conexiÃ³n con Supabase
 */
async function getOrCreateConfig() {
  // 1. Obtener todas las configuraciones globales ordenadas consistentemente por fecha de creación
  let configs = await withConnectionRetry(
    () => prisma.sorteosAutoConfig.findMany({
      where: { bancaId: null },
      orderBy: { createdAt: 'asc' }
    }),
    {
      maxRetries: 3,
      backoffMinMs: 1000,
      backoffMaxMs: 5000,
      context: 'getOrCreateConfigList',
    }
  );
  
  // 2. Si no existe ninguna, crear una sola
  if (configs.length === 0) {
    const config = await withConnectionRetry(
      () =>
        prisma.sorteosAutoConfig.create({
          data: {
            bancaId: null,
            autoOpenEnabled: false,
            autoCreateEnabled: false,
            autoCloseEnabled: false,
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
    return config;
  }
  
  // 3. AUTOCURACIÓN PROGRAMÁTICA: Si existen registros duplicados históricos en tu DB
  if (configs.length > 1) {
    logger.warn({
      layer: 'service',
      action: 'SORTEOS_AUTO_CONFIG_DUPLICATES_DETECTED',
      payload: { count: configs.length },
    });
    
    const primary = configs[0];
    const duplicates = configs.slice(1);
    
    // Fusionar las fechas de ejecución más recientes entre todos los registros duplicados en memoria
    let latestOpen = primary.lastOpenExecution;
    let latestCreate = primary.lastCreateExecution;
    let latestClose = primary.lastCloseExecution;
    let latestOpenCount = primary.lastOpenCount;
    let latestCreateCount = primary.lastCreateCount;
    let latestCloseCount = primary.lastCloseCount;
    
    for (const dup of duplicates) {
      if (dup.lastOpenExecution && (!latestOpen || dup.lastOpenExecution > latestOpen)) {
        latestOpen = dup.lastOpenExecution;
        latestOpenCount = dup.lastOpenCount;
      }
      if (dup.lastCreateExecution && (!latestCreate || dup.lastCreateExecution > latestCreate)) {
        latestCreate = dup.lastCreateExecution;
        latestCreateCount = dup.lastCreateCount;
      }
      if (dup.lastCloseExecution && (!latestClose || dup.lastCloseExecution > latestClose)) {
        latestClose = dup.lastCloseExecution;
        latestCloseCount = dup.lastCloseCount;
      }
    }
    
    // Actualizar el registro primario con la información consolidada
    await prisma.sorteosAutoConfig.update({
      where: { id: primary.id },
      data: {
        lastOpenExecution: latestOpen,
        lastOpenCount: latestOpenCount,
        lastCreateExecution: latestCreate,
        lastCreateCount: latestCreateCount,
        lastCloseExecution: latestClose,
        lastCloseCount: latestCloseCount,
        autoOpenEnabled: configs.some(c => c.autoOpenEnabled),
        autoCreateEnabled: configs.some(c => c.autoCreateEnabled),
        autoCloseEnabled: configs.some(c => c.autoCloseEnabled),
      }
    });
    
    // Eliminar programáticamente los registros duplicados huérfanos
    const duplicateIds = duplicates.map(d => d.id);
    await prisma.sorteosAutoConfig.deleteMany({
      where: { id: { in: duplicateIds } }
    });
    
    logger.info({
      layer: 'service',
      action: 'SORTEOS_AUTO_CONFIG_DEDUPLICATED',
      payload: { primaryId: primary.id, deletedIds: duplicateIds },
    });
    
    // Retornar el registro único y consolidado
    return prisma.sorteosAutoConfig.findUniqueOrThrow({
      where: { id: primary.id }
    });
  }
  
  return configs[0];
}

function getTodayRangeCR(): { start: Date; end: Date } {
  const now = new Date();
  return { start: tz.startOfDay(now), end: tz.endOfDay(now) };
}

export const SorteosAutoService = {
  /**
   * Obtiene la configuraciÃ³n actual
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
   * Actualiza la configuraciÃ³n
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
   * Ejecuta la apertura automÃ¡tica de sorteos del dÃ­a
   */
  async executeAutoOpen(userId: string | null, isManual: boolean = false): Promise<{
    success: boolean;
    openedCount: number;
    errors: Array<{ sorteoId: string; error: string }>;
    executedAt: Date;
  }> {
    const config = await getOrCreateConfig();
    
    if (!config.autoOpenEnabled && !isManual) {
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
    
    // Buscar sorteos SCHEDULED del dÃ­a actual (en hora CR)
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
        await SorteoService.open(sorteo.id, userId as string);
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

    // Actualizar configuraciÃ³n con Ãºltima ejecuciÃ³n
    await prisma.sorteosAutoConfig.update({
      where: { id: config.id },
      data: {
        lastOpenExecution: new Date(),
        lastOpenCount: openedCount,
      },
    });

    // Registrar en ActivityLog
    await ActivityService.log({
      action: 'SYSTEM_ACTION',
      targetType: 'CRON_JOB',
      targetId: 'sorteos_auto_open',
      details: {
        status: errors.length === 0 ? 'success' : 'partial',
        affectedRows: openedCount,
        errorsCount: errors.length,
      },
    });

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
   * Ejecuta la creaciÃ³n automÃ¡tica de sorteos futuros
   */
  async executeAutoCreate(daysAhead: number = 1, userId?: string | null, isManual: boolean = false): Promise<{
    success: boolean;
    createdCount: number;
    skippedCount: number;
    errors: Array<{ loteriaId: string; error: string }>;
    executedAt: Date;
  }> {
    const config = await getOrCreateConfig();
    
    if (!config.autoCreateEnabled && !isManual) {
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

    // Buscar loterÃ­as activas con reglas configuradas
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

    const today = tz.startOfDay(new Date());
    const minDaysAhead = 1; // MÃ­nimo de dÃ­as futuros: 1 dÃ­a (el cron corre diario)
    
    for (const loteria of loterias) {
      try {
        const rules = loteria.rulesJson as any;
        
        // Verificar si tiene drawSchedule o drawSchedules configurados con horas válidas
        const hasClassicSchedule = rules?.drawSchedule?.times && rules.drawSchedule.times.length > 0;
        const hasMultiSchedule = Array.isArray(rules?.drawSchedules) && rules.drawSchedules.some((s: any) => s.times && s.times.length > 0);

        if (!hasClassicSchedule && !hasMultiSchedule) {
          logger.debug({
            layer: 'service',
            action: 'SORTEOS_AUTO_CREATE_SKIP_LOTERIA',
            payload: {
              loteriaId: loteria.id,
              reason: 'No tiene horarios (drawSchedule o drawSchedules) configurados',
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

        // Verificar cuÃ¡l es el Ãºltimo sorteo futuro para esta loterÃ­a
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

        // Determinar desde dÃ³nde generar sorteos
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
          const lastSorteoDate = tz.startOfDay(lastSorteo.scheduledAt);
          const daysUntilLast = Math.ceil(
            (lastSorteoDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)
          );

          if (daysUntilLast < minDaysAhead) {
            // El Ãºltimo sorteo estÃ¡ muy cerca, generar desde el dÃ­a siguiente al Ãºltimo
            startDate = tz.addDays(lastSorteoDate, 1);
            // Generar suficientes dÃ­as para tener al menos minDaysAhead + daysAhead dÃ­as futuros
            actualDaysAhead = daysAhead;
            
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
        // forceCreate = false para respetar la bandera autoCreateSorteos en autogeneraciÃ³n automÃ¡tica
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

    // Actualizar configuraciÃ³n con Ãºltima ejecuciÃ³n
    await prisma.sorteosAutoConfig.update({
      where: { id: config.id },
      data: {
        lastCreateExecution: new Date(),
        lastCreateCount: totalCreated,
      },
    });

    // Registrar en ActivityLog
    await ActivityService.log({
      action: 'SYSTEM_ACTION',
      targetType: 'CRON_JOB',
      targetId: 'sorteos_auto_create',
      details: {
        status: errors.length === 0 ? 'success' : 'partial',
        affectedRows: totalCreated,
        skipped: totalSkipped,
        errorsCount: errors.length,
      },
    });

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
   * Ejecuta el cierre automÃ¡tico de sorteos sin ventas
   *
   * Cierra automÃ¡ticamente sorteos que cumplen TODAS estas condiciones:
   * - Estado: SCHEDULED u OPEN
   * - scheduledAt hace mÃ¡s de 5 minutos
   * - 0 tickets vendidos (incluyendo anulados)
   * - isActive = true
   * - deletedAt IS NULL
   */
  async executeAutoClose(userId: string | null, isManual: boolean = false): Promise<{
    success: boolean;
    closedCount: number;
    errors: Array<{ sorteoId: string; sorteoName: string; error: string }>;
    executedAt: Date;
  }> {
    const config = await getOrCreateConfig();

    if (!config.autoCloseEnabled && !isManual) {
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

    //  MEJORADO: Buscar sorteos candidatos con reintentos ante errores de conexiÃ³n
    // Buscar sorteos candidatos: SCHEDULED u OPEN hace mÃ¡s de 5 minutos
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
          //  MEJORADO: Reintentos ante errores de conexiÃ³n
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
          await SorteoService.close(sorteo.id, userId as string);
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

    //  MEJORADO: Actualizar configuraciÃ³n con Ãºltima ejecuciÃ³n (con reintentos)
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

    // Registrar en ActivityLog
    await ActivityService.log({
      action: 'SYSTEM_ACTION',
      targetType: 'CRON_JOB',
      targetId: 'sorteos_auto_close',
      details: {
        status: errors.length === 0 ? 'success' : (closedCount > 0 ? 'partial' : 'error'),
        affectedRows: closedCount,
        errorsCount: errors.length,
      },
    });

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

    function buildStatus(lastExecution: Date | null, lastCount: number | null, healthyThresholdHours: number) {
      if (!lastExecution) {
        return {
          isHealthy: false,
          lastExecution: null,
          hoursSinceLastRun: null,
          lastExecutionCount: null,
          status: 'never_run' as const,
        };
      }
      const hoursSince = (Date.now() - lastExecution.getTime()) / (1000 * 60 * 60);
      return {
        isHealthy: hoursSince < healthyThresholdHours,
        lastExecution,
        hoursSinceLastRun: Math.round(hoursSince * 100) / 100,
        lastExecutionCount: lastCount,
        status: 'ok' as const,
      };
    }

    return {
      open: buildStatus(config.lastOpenExecution, config.lastOpenCount, 30),
      create: buildStatus(config.lastCreateExecution, config.lastCreateCount, 30),
      close: buildStatus(config.lastCloseExecution, config.lastCloseCount, 30),
      config: {
        autoOpenEnabled: config.autoOpenEnabled,
        autoCreateEnabled: config.autoCreateEnabled,
        autoCloseEnabled: config.autoCloseEnabled,
      },
    };
  },
};

export default SorteosAutoService;





