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

const prismaDirect = global.__prismaDirect ?? createDirectClient();
global.__prismaDirect = prismaDirect;

export default prismaDirect;
