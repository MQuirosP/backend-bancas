
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const multipliers = await prisma.loteriaMultiplier.findMany({
    where: { bancaId: '0d1e21c8-0d06-45a8-bd7a-e8af9ea78737', isActive: true },
    select: { id: true, loteriaId: true, name: true, valueX: true }
  });
  console.log('Multiplicadores activos Moncho:', multipliers.length);
  console.log('Muestra:', JSON.stringify(multipliers.slice(0, 5), null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
