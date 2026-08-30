const { PrismaClient } = require('./src/generated/prisma/client');
const prisma = new PrismaClient();

async function main() {
  const sorteoId = '97d2a621-72ad-4dc8-a8c8-278999b2e0a8';
  
  // Get all jugadas for this sorteo
  const jugadas = await prisma.$queryRaw`
    SELECT j."multiplierId", SUM(j.amount) as "mSales", SUM(j."commissionAmount") as "mCommission"
    FROM "Ticket" t
    JOIN "Jugada" j ON j."ticketId" = t.id
    WHERE t."sorteoId" = CAST(${sorteoId} AS uuid)
      AND t."deletedAt" IS NULL
      AND j."deletedAt" IS NULL
      AND j."isActive" = true
    GROUP BY j."multiplierId"
  `;
  
  console.log('Jugadas agregadas:', jugadas);
  
  const allMultipliers = await prisma.loteriaMultiplier.findMany();
  console.log('Todos los Multiplicadores en BD:', allMultipliers.filter(m => jugadas.map(j => j.multiplierId).includes(m.id)));
}

main().catch(console.error).finally(() => prisma.$disconnect());
