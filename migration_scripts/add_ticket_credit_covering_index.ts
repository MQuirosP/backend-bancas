import prisma from '../src/core/prismaClient';

async function main() {
  console.log('🚀 Optimizando índice cubriente para crédito en Ticket...');
  try {
    // 1. Crear índice cubriente con INCLUDE concurrentemente
    console.log('Creando idx_ticket_vendedor_businessdate_covering...');
    await prisma.$executeRawUnsafe(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ticket_vendedor_businessdate_covering
      ON "Ticket" ("vendedorId", "businessDate")
      INCLUDE ("id", "sorteoId")
      WHERE ("deletedAt" IS NULL AND "isActive" = true AND status <> ALL (ARRAY['CANCELLED'::"TicketStatus", 'EXCLUDED'::"TicketStatus"]));
    `);
    console.log('✅ Índice cubriente idx_ticket_vendedor_businessdate_covering creado con éxito.');

    // 2. Podar índice antiguo no cubriente para evitar sobreindexación
    console.log('Podando idx_ticket_vendedor_businessdate no cubriente...');
    await prisma.$executeRawUnsafe(`
      DROP INDEX CONCURRENTLY IF EXISTS idx_ticket_vendedor_businessdate;
    `);
    console.log('✅ Índice redundante no cubriente idx_ticket_vendedor_businessdate podado exitosamente.');
  } catch (err: any) {
    console.error('❌ Error en migración de índice:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
