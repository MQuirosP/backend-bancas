import prisma from './src/core/prismaClient';

async function main() {
  const rules = await prisma.restrictionRule.findMany({
    where: { isActive: true },
    include: { loteria: true, multiplier: true },
  });
  console.log('RULES COUNT:', rules.length);
  for (const r of rules) {
    console.log({
      id: r.id,
      number: r.number,
      maxAmount: r.maxAmount,
      maxTotal: r.maxTotal,
      baseAmount: r.baseAmount,
      salesPercentage: r.salesPercentage,
      salesCutoffMinutes: r.salesCutoffMinutes,
      loteria: r.loteria?.name,
      loteriaId: r.loteriaId,
      multiplier: r.multiplier?.name,
      multiplierId: r.multiplierId,
      userId: r.userId,
      ventanaId: r.ventanaId,
      bancaId: r.bancaId,
      appliesToHour: r.appliesToHour,
      appliesToDate: r.appliesToDate,
      isAutoDate: r.isAutoDate,
    });
  }

  // Also check sorteos
  const sorteos = await prisma.sorteo.findMany({
    where: { status: 'OPEN' },
    include: { loteria: true }
  });
  console.log('OPEN SORTEOS:', sorteos.map(s => ({ id: s.id, description: s.description, scheduledAt: s.scheduledAt, loteria: s.loteria?.name })));
}

main().catch(console.error).finally(() => process.exit(0));
