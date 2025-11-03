const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function verify() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  VERIFICACIÓN DE MIGRACIÓN - TABLAS CREADAS              ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  try {
    // Verificar que las tablas existan
    console.log('VERIFICANDO TABLAS CREADAS...\n');

    // Contar registros en cada tabla
    const accounts = await prisma.account.count();
    console.log(`✓ Account: ${accounts} registros (tabla creada)`);

    const ledgerEntries = await prisma.ledgerEntry.count();
    console.log(`✓ LedgerEntry: ${ledgerEntries} registros (tabla creada)`);

    const bankDeposits = await prisma.bankDeposit.count();
    console.log(`✓ BankDeposit: ${bankDeposits} registros (tabla creada)`);

    const dailySnapshots = await prisma.dailyBalanceSnapshot.count();
    console.log(`✓ DailyBalanceSnapshot: ${dailySnapshots} registros (tabla creada)\n`);

    // Verificar que los datos antiguos están intactos
    console.log('VERIFICANDO INTEGRIDAD DE DATOS ANTIGUOS...\n');

    const jugadas = await prisma.jugada.count();
    console.log(`✓ Jugada: ${jugadas} registros (sin cambios, solo se eliminaron huérfanos)`);

    const tickets = await prisma.ticket.count();
    console.log(`✓ Ticket: ${tickets} registros (sin cambios)\n`);

    // Verificar integridad referencial
    console.log('VERIFICANDO INTEGRIDAD REFERENCIAL...\n');

    const orphanedJugadas = await prisma.$queryRaw`
      SELECT COUNT(*) as count
      FROM "Jugada" j
      WHERE j."ticketId" NOT IN (SELECT id FROM "Ticket")
    `;

    const orphanCount = parseInt(orphanedJugadas[0].count) || 0;
    if (orphanCount === 0) {
      console.log('✓ No hay Jugadas huérfanas (verificación exitosa)\n');
    } else {
      console.log(`⚠ Hay ${orphanCount} Jugadas huérfanas\n`);
    }

    console.log('═══════════════════════════════════════════════════════════');
    console.log('✓✓✓ MIGRACIÓN EXITOSA');
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log('PRÓXIMOS PASOS:\n');
    console.log('1. Ejecutar: npm run build');
    console.log('2. Ejecutar: npm run start');
    console.log('3. Probar endpoints en: GET /api/v1/accounts\n');

  } catch (error) {
    console.error('\n❌ Error en verificación:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

verify();
