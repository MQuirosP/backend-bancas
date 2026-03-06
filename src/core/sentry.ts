// src/core/sentry.ts
import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import { config } from "../config";
import logger from "./logger";

/**
 * Inicializa Sentry para monitoreo de errores y performance
 */
export function initSentry() {
  if (!config.sentry.dsn) {
    logger.info({
      layer: 'core',
      action: 'SENTRY_INIT_SKIP',
      payload: { message: 'Sentry DSN not provided, skipping initialization' }
    });
    return;
  }

  try {
    Sentry.init({
      dsn: config.sentry.dsn,
      environment: config.nodeEnv,
      integrations: [
        nodeProfilingIntegration(),
      ],
      // Performance Monitoring
      tracesSampleRate: config.sentry.tracesSampleRate,
      // Profiling
      profilesSampleRate: config.sentry.profilesSampleRate,
    });

    logger.info({
      layer: 'core',
      action: 'SENTRY_INIT_SUCCESS',
      payload: { environment: config.nodeEnv }
    });
  } catch (error: any) {
    logger.error({
      layer: 'core',
      action: 'SENTRY_INIT_ERROR',
      meta: { error: error.message }
    });
  }
}

export default Sentry;
