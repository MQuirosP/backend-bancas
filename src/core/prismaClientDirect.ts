import { PrismaClient } from "@prisma/client";

declare global {
  var __prismaDirect: PrismaClient | undefined;
}

/**
 * Cliente Prisma para operaciones que necesitan conexión directa/estable:
 * - Jobs programados (cron)
 * - Migraciones
 * - Operaciones de larga duración
 *
 * Usa DIRECT_URL que apunta al Session Pooler (puerto 5432) o conexión directa,
 * más estable que el Transaction Pooler (puerto 6543) para conexiones "frías".
 *
 * Si DIRECT_URL no está configurado, usa DATABASE_URL como fallback.
 */
function createDirectClient(): PrismaClient {
  const directUrl = process.env.DIRECT_URL;

  if (!directUrl) {
    console.warn(
      "[PRISMA_DIRECT] DIRECT_URL no configurada, usando DATABASE_URL como fallback"
    );
    return new PrismaClient({ log: ["warn", "error"] });
  }

  return new PrismaClient({
    log: ["warn", "error"],
    datasources: {
      db: {
        url: directUrl,
      },
    },
  });
}

/**
 * Retorna la instancia del cliente directo de forma perezosa (Lazy Load).
 * Solo se inicializa la primera vez que se invoca.
 *
 * NOTA DE ARQUITECTURA: Esto evita que el pool de conexiones directas (puerto 5432)
 * se levante automáticamente al arrancar la API, ahorrando slots en PgBouncer.
 */
export function getPrismaDirect(): PrismaClient {
  if (!global.__prismaDirect) {
    global.__prismaDirect = createDirectClient();
  }
  return global.__prismaDirect;
}
