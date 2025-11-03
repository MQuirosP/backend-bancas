const { PrismaClient } = require('@prisma/client');
const readline = require('readline');

const prisma = new PrismaClient();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function deleteOrphanedJugadas() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  ELIMINACIÓN SEGURA DE JUGADAS HUÉRFANAS                 ║');
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
      rl.close();
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
      console.log(
        `  ${idx + 1}. ID: ${j.id}`
      );
      console.log(`     TicketID: ${j.ticketId} (NO EXISTE)`);
      console.log(`     Número: ${j.number}`);
      console.log(`     Monto: ${j.amount}`);
      console.log(`     Fecha: ${j.createdAt}\n`);
    });

    // 3. Confirmación
    console.log('⚠️  ADVERTENCIA: Esta acción es IRREVERSIBLE');
    console.log(`Se eliminarán ${jugadasHuerfanas} registros de la base de datos de PRODUCCIÓN.\n`);

    const confirmation = await question(
      '¿Deseas continuar? Escribe "SÍ" para confirmar (mayúsculas): '
    );

    if (confirmation !== 'SÍ') {
      console.log('\n✗ Operación cancelada. No se eliminó nada.\n');
      rl.close();
      await prisma.$disconnect();
      process.exit(0);
    }

    // 4. Eliminar
    console.log('\nPASO 3: Eliminando registros...\n');

    const deleteResult = await prisma.$executeRaw`
      DELETE FROM "Jugada"
      WHERE "ticketId" NOT IN (SELECT id FROM "Ticket")
    `;

    console.log(`✓ Eliminados ${deleteResult} registros huérfanos\n`);

    // 5. Verificar
    console.log('PASO 4: Verificando...\n');

    const jugadasHuerfanasVerify = await prisma.$queryRaw`
      SELECT COUNT(*) as count
      FROM "Jugada" j
      WHERE j."ticketId" NOT IN (SELECT id FROM "Ticket")
    `;
    const remaining = parseInt(jugadasHuerfanasVerify[0].count) || 0;

    if (remaining === 0) {
      console.log('✓✓✓ Verificación exitosa: No quedan registros huérfanos\n');
      console.log(
        '═══════════════════════════════════════════════════════════'
      );
      console.log('LA BASE DE DATOS ESTÁ LISTA PARA LA MIGRACIÓN');
      console.log(
        '═══════════════════════════════════════════════════════════\n'
      );
      console.log(
        'Próximo paso: npx prisma db push --skip-generate\n'
      );
    } else {
      console.log(`⚠ Advertencia: Aún hay ${remaining} registros huérfanos\n`);
    }

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error('\nNo se realizaron cambios.\n');
  } finally {
    rl.close();
    await prisma.$disconnect();
  }
}

deleteOrphanedJugadas();
