const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function analyze() {
  console.log('=== ANÁLISIS DE JUGADAS HUÉRFANAS ===\n');

  try {
    // Total de Jugadas
    const totalJugadas = await prisma.jugada.count();
    console.log('✓ Total de Jugadas en base de datos:', totalJugadas);

    // Jugadas huérfanas con raw query
    const jugadasHuerfanasList = await prisma.$queryRaw`
      SELECT COUNT(*) as count
      FROM "Jugada" j
      WHERE j."ticketId" NOT IN (SELECT id FROM "Ticket")
    `;

    const jugadasHuerfanas = parseInt(jugadasHuerfanasList[0].count) || 0;
    const jugadasValidas = totalJugadas - jugadasHuerfanas;

    console.log('✓ Jugadas con Ticket válido:', jugadasValidas);
    console.log('✓ Jugadas HUÉRFANAS (sin Ticket):', jugadasHuerfanas);

    if (totalJugadas > 0) {
      const porcentaje = ((jugadasHuerfanas / totalJugadas) * 100).toFixed(2);
      console.log(`  Porcentaje: ${porcentaje}%\n`);
    }

    if (jugadasHuerfanas > 0) {
      console.log('=== MUESTRA DE JUGADAS HUÉRFANAS ===\n');
      const sample = await prisma.$queryRaw`
        SELECT j.id, j."ticketId", j.number, j.amount, j."createdAt"
        FROM "Jugada" j
        WHERE j."ticketId" NOT IN (SELECT id FROM "Ticket")
        ORDER BY j."createdAt" DESC
        LIMIT 10
      `;

      console.log(`Primeras 10 Jugadas huérfanas:`);
      sample.forEach((j, idx) => {
        console.log(`${idx + 1}. ID: ${j.id} | TicketID: ${j.ticketId} | Número: ${j.number} | Monto: ${j.amount} | Fecha: ${j.createdAt}`);
      });

      console.log('\n=== RECOMENDACIÓN ===');
      if (jugadasHuerfanas <= 100) {
        console.log(`✓ Seguro eliminar: ${jugadasHuerfanas} registros huérfanos (cantidad pequeña)`);
        console.log('\nPróximo paso: ejecutar script de eliminación');
      } else if (jugadasHuerfanas <= 1000) {
        console.log(`⚠ Revisar antes de eliminar: ${jugadasHuerfanas} registros huérfanos (cantidad moderada)`);
      } else {
        console.log(`🔴 CUIDADO: ${jugadasHuerfanas} registros huérfanos (cantidad grande - investigar raíz del problema)`);
      }
    } else {
      console.log('✓✓✓ No hay Jugadas huérfanas - seguro ejecutar migración');
    }

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

analyze();
