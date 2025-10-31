// tests/tickets/helpers/resetDatabase.ts
import prisma from "../../../src/core/prismaClient";

export async function resetDatabase() {
  // ⚠️ GUARDS DE SEGURIDAD: Verificar que NO estamos en producción
  const dbUrl = process.env.DATABASE_URL || '';
  const nodeEnv = process.env.NODE_ENV;

  // 1. Verificar NODE_ENV
  if (nodeEnv === 'production' || nodeEnv === 'staging') {
    throw new Error(
      `🚨 SEGURIDAD: resetDatabase() NO puede ejecutarse en ${nodeEnv}!\n` +
      'Por favor verifica tu configuración de entorno.'
    );
  }

  // 2. Verificar DATABASE_URL no es producción
  if (
    dbUrl.includes('supabase.com') ||
    dbUrl.includes('production') ||
    dbUrl.includes('prod') ||
    dbUrl.includes('render.com') ||
    dbUrl.includes('amazonaws.com')
  ) {
    throw new Error(
      '🚨 SEGURIDAD: resetDatabase() NO puede ejecutarse contra producción!\n' +
      `DATABASE_URL: ${dbUrl}\n` +
      'Por favor verifica tu configuración de entorno.'
    );
  }

  // 3. Verificar que es base de datos local (localhost)
  const isLocalDatabase = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');

  if (nodeEnv === 'test' && !isLocalDatabase) {
    throw new Error(
      '🚨 SEGURIDAD: resetDatabase() en modo test debe usar base de datos local!\n' +
      `   Esperado: postgresql://...@localhost:5432/bancas\n` +
      `   Actual: ${dbUrl}\n` +
      'Por favor verifica tu archivo .env.test'
    );
  }

  // 4. Ejecutar TRUNCATE solo si pasaron todos los guards
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ActivityLog",
      "TicketPayment",
      "Jugada",
      "Ticket",
      "RestrictionRule",
      "MultiplierOverride",
      "LoteriaMultiplier",
      "Sorteo",
      "Loteria",
      "BancaLoteriaSetting",
      "User",
      "Ventana",
      "Banca",
      "RefreshToken"
    RESTART IDENTITY CASCADE;
  `);

  if (process.env.LOG_LEVEL !== 'error') {
    console.log('✅ Test database reset successfully');
  }
}
