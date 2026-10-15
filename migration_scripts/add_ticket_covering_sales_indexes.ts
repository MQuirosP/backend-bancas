import prisma from '../src/core/prismaClient';

async function main() {
  console.log('🚀 Optimizando índices de la tabla Ticket...');

  try {
    // 1. Crear índices cubrientes con INCLUDE
    await prisma.$executeRawUnsafe(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ticket_sorteo_vendedor_covering_sales
      ON "Ticket" ("sorteoId", "vendedorId", "status")
      INCLUDE ("totalAmount")
      WHERE ("deletedAt" IS NULL AND "isActive" = true);
    `);
    console.log('✅ Índice cubriente idx_ticket_sorteo_vendedor_covering_sales listo.');

    await prisma.$executeRawUnsafe(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ticket_sorteo_ventana_covering_sales
      ON "Ticket" ("sorteoId", "ventanaId", "status")
      INCLUDE ("totalAmount")
      WHERE ("deletedAt" IS NULL AND "isActive" = true);
    `);
    console.log('✅ Índice cubriente idx_ticket_sorteo_ventana_covering_sales listo.');

    // 2. Podar índice redundante para mitigar sobreindexación (Ahorro de 15 MB)
    await prisma.$executeRawUnsafe(`
      DROP INDEX CONCURRENTLY IF EXISTS idx_ticket_sorteo_businessdate_active;
    `);
    console.log('✅ Índice redundante idx_ticket_sorteo_businessdate_active eliminado exitosamente.');
  } catch (err: any) {
    console.error('❌ Error gestionando índices:', err.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
