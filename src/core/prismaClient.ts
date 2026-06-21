import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

declare global {
  var __prisma: PrismaClient | undefined;
  var __prismaPool: Pool | undefined;
}

if (!global.__prismaPool) {
  let connectionLimit = 25; // default fallback
  if (process.env.DATABASE_URL) {
    try {
      const parsedUrl = new URL(process.env.DATABASE_URL);
      const limitParam = parsedUrl.searchParams.get("connection_limit");
      if (limitParam) {
        const parsedLimit = parseInt(limitParam, 10);
        if (!isNaN(parsedLimit) && parsedLimit > 0) {
          connectionLimit = parsedLimit;
        }
      }
    } catch (e) {
      // fallback
    }
  }

  global.__prismaPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: connectionLimit,
  });
}

const pool = global.__prismaPool;
const adapter = new PrismaPg(pool);

//  FIX: Cachear globalmente SIEMPRE (incluso en producción)
// Antes: Solo se cacheaba en development → múltiples instancias en production
// Ahora: Una sola instancia reutilizada → evita agotamiento de conexiones
const prisma = global.__prisma ?? new PrismaClient({
  adapter,
  log: ['warn', 'error'],
});

//  CRÍTICO: Cachear en producción también para evitar múltiples instancias
// Sin esto: cada import crea nueva instancia → exhausted connection pool
global.__prisma = prisma;

/**
 * Verifica la conexión ejecutando un ping simple.
 */
export async function verifyConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    return false;
  }
}

export default prisma;