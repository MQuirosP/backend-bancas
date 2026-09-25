import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

declare global {
  var __prisma: PrismaClient | undefined;
  var __salesPrisma: PrismaClient | undefined;
  var __prismaPool: Pool | undefined;
  var __salesPool: Pool | undefined;
}

function cleanConnectionString(rawUrl?: string): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const parsed = new URL(rawUrl);
    // Eliminar connection_limit de los query params para evitar conflictos con el constructor de pg.Pool
    parsed.searchParams.delete("connection_limit");
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

const cleanedDbUrl = cleanConnectionString(process.env.DATABASE_URL);

// Límites configurables con fallback estándar (8 ventas + 17 general = 25 global)
const salesPoolMax = Number(process.env.SALES_POOL_MAX || 8);
const generalPoolMax = Number(process.env.GENERAL_POOL_MAX || 17);

if (!global.__prismaPool) {
  global.__prismaPool = new Pool({
    connectionString: cleanedDbUrl,
    max: generalPoolMax,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10000,
    application_name: "bancas_backend_general",
  });
}

if (!global.__salesPool) {
  global.__salesPool = new Pool({
    connectionString: cleanedDbUrl,
    max: salesPoolMax,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10000,
    application_name: "bancas_backend_sales",
  });
}

export const generalPool: Pool = global.__prismaPool!;
export const salesPool: Pool = global.__salesPool!;

const generalAdapter = new PrismaPg(generalPool);
const salesAdapter = new PrismaPg(salesPool);

// Instancia General (Reportes, Dashboards, Cierres, Evaluaciones)
export const prisma: PrismaClient =
  global.__prisma ??
  new PrismaClient({
    adapter: generalAdapter,
    log: ["warn", "error"],
  });
global.__prisma = prisma;

// Instancia de Ventas (Fast-Path Crítico Exclusivo para Emisión de Tickets)
export const salesPrisma: PrismaClient =
  global.__salesPrisma ??
  new PrismaClient({
    adapter: salesAdapter,
    log: ["warn", "error"],
  });
global.__salesPrisma = salesPrisma;

/**
 * Verifica la conectividad de ambos pools ejecutando un ping simple en cada uno.
 */
export async function verifyConnection(): Promise<boolean> {
  try {
    await Promise.all([
      prisma.$queryRaw`SELECT 1`,
      salesPrisma.$queryRaw`SELECT 1`,
    ]);
    return true;
  } catch (error) {
    return false;
  }
}

export default prisma;