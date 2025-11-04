const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function verify() {
  console.log('\n=== COMMISSION CALCULATION VERIFICATION ===\n');

  // Show all jugadas with commission
  const jugadas = await prisma.jugada.findMany({
    where: {
      deletedAt: null,
      commissionAmount: { gt: 0 }
    },
    select: {
      isWinner: true,
      commissionAmount: true,
      payout: true,
      type: true,
    },
    take: 50,
  });

  const byWinner = jugadas.reduce((acc, j) => {
    const key = j.isWinner ? 'WINNER' : 'NON_WINNER';
    if (!acc[key]) acc[key] = [];
    acc[key].push(j);
    return acc;
  }, {});

  console.log('WINNERS with commission:');
  if (byWinner.WINNER) {
    const totalWinnerCommission = byWinner.WINNER.reduce((sum, j) => sum + j.commissionAmount, 0);
    console.log(`  Count: ${byWinner.WINNER.length}`);
    console.log(`  Total Commission: ₡${totalWinnerCommission}`);
    byWinner.WINNER.slice(0, 5).forEach(j => {
      console.log(`    - Type: ${j.type}, Commission: ₡${j.commissionAmount}, Payout: ${j.payout}`);
    });
  }

  console.log('\nNON-WINNERS with commission:');
  if (byWinner.NON_WINNER) {
    const totalNonWinnerCommission = byWinner.NON_WINNER.reduce((sum, j) => sum + j.commissionAmount, 0);
    console.log(`  Count: ${byWinner.NON_WINNER.length}`);
    console.log(`  Total Commission: ₡${totalNonWinnerCommission}`);
    byWinner.NON_WINNER.slice(0, 5).forEach(j => {
      console.log(`    - Type: ${j.type}, Commission: ₡${j.commissionAmount}, Payout: ${j.payout}`);
    });
  }

  console.log('\n=== SQL QUERY TEST ===\n');

  const today = new Date();
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const result = await prisma.$queryRawUnsafe(`
    SELECT
      COALESCE(SUM(t."totalAmount"), 0)::NUMERIC as "totalSales",
      COALESCE(SUM(CASE
        WHEN j."isWinner" = true THEN j."payout"
        ELSE 0
      END), 0)::NUMERIC as "totalPrizes",
      COALESCE(SUM(j."commissionAmount"), 0)::NUMERIC as "totalCommission"
    FROM "Ticket" t
    LEFT JOIN "Jugada" j ON t."id" = j."ticketId"
      AND j."isWinner" = true
      AND j."deletedAt" IS NULL
    WHERE
      t."deletedAt" IS NULL
      AND t."status" IN ('ACTIVE', 'EVALUATED', 'PAID')
      AND t."createdAt" >= $1::TIMESTAMP
      AND t."createdAt" <= $2::TIMESTAMP
  `, sevenDaysAgo.toISOString(), today.toISOString());

  console.log('Query result (week window):');
  console.log(`  Total Sales: ₡${result[0].totalSales}`);
  console.log(`  Total Prizes: ₡${result[0].totalPrizes}`);
  console.log(`  Total Commission: ₡${result[0].totalCommission}`);

  const netOperative = parseFloat(result[0].totalSales) - parseFloat(result[0].totalPrizes);
  console.log(`  Net Operative: ₡${netOperative}`);

  await prisma.$disconnect();
}

verify().catch(console.error);
