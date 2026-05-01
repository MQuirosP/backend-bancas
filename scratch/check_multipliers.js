const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const multipliers = await prisma.loteriaMultiplier.findMany({
    where: { loteriaId: '30bc554e-281b-4b72-b241-0904f7583e68' },
    select: { id: true, name: true, kind: true }
  });
  console.log(JSON.stringify(multipliers, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
