import pino from "pino";
import { config } from "../config";

export type LogPayload = {
  layer: string; // e.g. "controller", "service", "repository"
  action: string; // e.g. "TICKET_CREATE", "LOGIN"
  userId?: string | null;
  requestId?: string | null;
  payload?: unknown; // body / input
  meta?: Record<string, unknown> | null; // extra metadata (error details, db meta...)
};

/**
 * Base pino logger.
 * Use pino-pretty in dev for readable logs.
 */
const transport =
  config.nodeEnv !== "production"
    ? {
        target: "pino-pretty",
        options: {
          singleLine: true,
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      }
    : undefined;

const baseLogger = pino({ level: config.logLevel ?? "info", transport } as any);

/**
 * Strongly-typed helper - writes structured logs with required common fields.
 */
function logBase(level: "info" | "warn" | "error" | "debug", data: LogPayload) {
  const { layer, action, userId, requestId, payload, meta } = data;
  // Always include layer and action -- these are critical for tracing
  const logObject: Record<string, unknown> = {
    layer,
    action,
    userId: userId ?? null,
    requestId: requestId ?? null,
  };

  if (payload !== undefined) logObject.payload = payload;
  if (meta !== undefined) logObject.meta = meta;

  // call pino with appropriate level
  switch (level) {
    case "info":
      baseLogger.info(logObject);
      break;
    case "warn":
      baseLogger.warn(logObject);
      break;
    case "error":
      baseLogger.error(logObject);
      break;
    case "debug":
      baseLogger.debug(logObject);
      break;
    default:
      baseLogger.info(logObject);
  }
}

export const logger = {
  raw: baseLogger, // direct access when needed
  info: (data: LogPayload) => logBase("info", data),
  warn: (data: LogPayload) => logBase("warn", data),
  error: (data: LogPayload) => logBase("error", data),
  debug: (data: LogPayload) => logBase("debug", data),
  /**
   * Create a child logger prefilled with given bindings (useful in middlewares).
   * Example: const reqLogger = logger.child({ requestId, userId })
   */
  child: (bindings: Record<string, unknown>) => baseLogger.child(bindings),
};

export default logger;
