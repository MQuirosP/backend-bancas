const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function checkMarcelaBalance() {
  const vendedorId = "c127ba4b-fefc-47d2-a67b-7cce92319621";
  const month = "2026-01";

  console.log(
    `Checking balance for vendedorId: ${vendedorId} in month: ${month}`
  );

  // 1. Check previous month balance (Dec 2025)
  const prevMonthStatement = await prisma.accountStatement.findFirst({
    where: {
      vendedorId: vendedorId,
      date: {
        lte: new Date("2025-12-31T23:59:59.999Z"),
      },
    },
    orderBy: { date: "desc" },
  });
  console.log("Previous Month Statement:", prevMonthStatement);

  // 2. Check statements in Jan 2026
  const janStatements = await prisma.accountStatement.findMany({
    where: {
      vendedorId: vendedorId,
      date: {
        gte: new Date("2026-01-01T00:00:00.000Z"),
        lte: new Date("2026-01-31T23:59:59.999Z"),
      },
    },
    orderBy: { date: "asc" },
  });
  console.log(
    "Jan 2026 Statements:",
    janStatements.map((s) => ({
      date: s.date.toISOString().split("T")[0],
      totalSales: s.totalSales,
      totalPayouts: s.totalPayouts,
      balance: s.balance,
      remainingBalance: s.remainingBalance,
      accumulatedBalance: s.accumulatedBalance,
    }))
  );

  // 3. Check for tickets today (Jan 4)
  const ticketsToday = await prisma.ticket.aggregate({
    where: {
      vendedorId: vendedorId,
      businessDate: new Date("2026-01-04T00:00:00.000Z"),
    },
    _sum: {
      totalAmount: true,
      totalPayout: true,
    },
  });
  console.log("Tickets Today (Jan 4):", ticketsToday);

  // 4. Check for movements in Jan
  const movements = await prisma.accountPayment.findMany({
    where: {
      vendedorId: vendedorId,
      date: {
        gte: "2026-01-01",
        lte: "2026-01-31",
      },
    },
  });
  console.log("Movements in Jan:", movements);
}

checkMarcelaBalance()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
