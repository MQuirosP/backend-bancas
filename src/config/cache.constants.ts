/**
 * Constantes y Enums de TTL centralizados para Caché (L1 RAM y Redis L2)
 * Eliminan la magia numérica dispersa a lo largo del sistema.
 */

export const CACHE_TTL_SECONDS = {
  /** 24 horas: Entidades maestras cuasi-estáticas (Ventana, Loteria, Multiplicadores, Reglas, Sorteo) */
  MASTER_ENTITY_24H: 86400,

  /** 12 horas: Sesiones y estados transitorios prolongados */
  SESSION_12H: 43200,

  /** 2 horas: Cutoff resolved L2 */
  CUTOFF_RESOLVED_2H: 7200,

  /** 1 hora */
  ONE_HOUR: 3600,

  /** 20 minutos: Cache de reportes evaluados y resúmenes de cierre */
  REPORT_SUMMARY_20M: 1200,

  /** 10 minutos: Cache de reportes operativos */
  REPORT_OPERATIONAL_10M: 600,

  /** 5 minutos: TTL base de precarga */
  FIVE_MINUTES: 300,

  /** 1 minuto */
  ONE_MINUTE: 60,

  /** 30 segundos: TTL de Redis para validaciones rápidas */
  FAST_PATH_30S: 30,
} as const;

export const CACHE_TTL_MS = {
  /** 5 minutos: TTL en L1 para entidades maestras en fast-path de ventas */
  L1_ENTITY_MS: 300_000,

  /** 60 segundos: Memoria local RAM pura */
  L1_LOCAL_RAM_MS: 60_000,

  /** 30 segundos: Validación de reglas en memoria L1 */
  L1_FAST_PATH_RULES_MS: 30_000,

  /** 15 segundos: Cache L1 de reglas compiladas */
  L1_COMPILED_RULES_MS: 15_000,

  /** 8 segundos: Micro-caché RAM post-evaluación (Warmup Before Broadcast) */
  L1_CREDIT_STATUS_WARM_MS: 8_000,

  /** 4 segundos: Micro-caché RAM local base para saldos en vivo (/status/me) */
  L1_CREDIT_STATUS_BASE_MS: 4_000,

  /** 2.5 segundos: Ventana de dispersión de backoff para WebSockets */
  SYNC_BACKOFF_WINDOW_MS: 2_500,
} as const;

