const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function deleteOrphanedJugadas() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  ELIMINACIÓN SEGURA DE JUGADAS HUÉRFANAS - PASO A PASO   ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  try {
    // 1. Análisis
    console.log('PASO 1: Analizando registros...\n');

    const totalJugadas = await prisma.jugada.count();
    console.log(`  Total de Jugadas: ${totalJugadas}`);

    const jugadasHuerfanasList = await prisma.$queryRaw`
      SELECT COUNT(*) as count
      FROM "Jugada" j
      WHERE j."ticketId" NOT IN (SELECT id FROM "Ticket")
    `;
    const jugadasHuerfanas = parseInt(jugadasHuerfanasList[0].count) || 0;

    console.log(`  Jugadas HUÉRFANAS: ${jugadasHuerfanas}`);
    console.log(`  Jugadas VÁLIDAS: ${totalJugadas - jugadasHuerfanas}\n`);

    if (jugadasHuerfanas === 0) {
      console.log('✓ No hay registros huérfanos. La base de datos está limpia.');
      await prisma.$disconnect();
      process.exit(0);
    }

    // 2. Mostrar detalles
    console.log('PASO 2: Detalles de registros a eliminar\n');

    const huerfanos = await prisma.$queryRaw`
      SELECT j.id, j."ticketId", j.number, j.amount, j."createdAt"
      FROM "Jugada" j
      WHERE j."ticketId" NOT IN (SELECT id FROM "Ticket")
      ORDER BY j."createdAt" DESC
    `;

    huerfanos.forEach((j, idx) => {
      console.log(`  ${idx + 1}. ID: ${j.id}`);
      console.log(`     TicketID: ${j.ticketId} (NO EXISTE)`);
      console.log(`     Número: ${j.number}`);
      console.log(`     Monto: ${j.amount}`);
      console.log(`     Fecha: ${j.createdAt}\n`);
    });

    // 3. Confirmación visual
    console.log('═══════════════════════════════════════════════════════════');
    console.log('⚠️  ADVERTENCIA: Esta acción es IRREVERSIBLE');
    console.log(`Se eliminarán ${jugadasHuerfanas} registros de PRODUCCIÓN.`);
    console.log('═══════════════════════════════════════════════════════════\n');

    // 4. EJECUTAR - Sin confirmación interactiva, requiere envío manual
    console.log('PASO 3: Eliminando registros...\n');

    const deleteResult = await prisma.$executeRaw`
      DELETE FROM "Jugada"
      WHERE "ticketId" NOT IN (SELECT id FROM "Ticket")
    `;

    console.log(`✓✓✓ SE ELIMINARON ${deleteResult} registros huérfanos\n`);

    // 5. Verificar
    console.log('PASO 4: Verificando integridad...\n');

    const jugadasHuerfanasVerify = await prisma.$queryRaw`
      SELECT COUNT(*) as count
      FROM "Jugada" j
      WHERE j."ticketId" NOT IN (SELECT id FROM "Ticket")
    `;
    const remaining = parseInt(jugadasHuerfanasVerify[0].count) || 0;

    if (remaining === 0) {
      const totalJugadasFinal = await prisma.jugada.count();
      console.log('✓ Verificación exitosa: No quedan registros huérfanos');
      console.log(`  Total final de Jugadas: ${totalJugadasFinal} (era ${totalJugadas})\n`);
      console.log('═══════════════════════════════════════════════════════════');
      console.log('LA BASE DE DATOS ESTÁ LISTA PARA LA MIGRACIÓN');
      console.log('═══════════════════════════════════════════════════════════\n');
      console.log('Próximo paso:\n');
      console.log('  npx prisma db push --skip-generate\n');
    } else {
      console.log(`⚠ Advertencia: Aún hay ${remaining} registros huérfanos\n`);
    }

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error('\nVerificando si se realizaron cambios...\n');

    try {
      const jugadasHuerfanasCheck = await prisma.$queryRaw`
        SELECT COUNT(*) as count
        FROM "Jugada" j
        WHERE j."ticketId" NOT IN (SELECT id FROM "Ticket")
      `;
      const remaining = parseInt(jugadasHuerfanasCheck[0].count) || 0;
      console.log(`Registros huérfanos restantes: ${remaining}`);
    } catch (e) {
      console.log('No se pudo verificar el estado.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

deleteOrphanedJugadas();
