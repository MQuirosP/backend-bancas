import { PrismaClient } from "@prisma/client";

declare global {
    var __prisma: PrismaClient | undefined;
}

//  FIX: Cachear globalmente SIEMPRE (incluso en producción)
// Antes: Solo se cacheaba en development → múltiples instancias en production
// Ahora: Una sola instancia reutilizada → evita agotamiento de conexiones
const prisma = global.__prisma ?? new PrismaClient({
    log: ['warn', 'error'],
});

//  CRÍTICO: Cachear en producción también para evitar múltiples instancias
// Sin esto: cada import crea nueva instancia → exhausted connection pool
global.__prisma = prisma;

export default prisma;