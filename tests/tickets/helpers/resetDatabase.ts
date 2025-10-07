import prisma from '../../../src/core/prismaClient';

export async function resetDatabase() {
  // 🔹 Eliminar en orden descendente de dependencias (hijos → padres)
  await prisma.jugada.deleteMany();          // depende de ticket
  await prisma.ticket.deleteMany();          // depende de ventana, sorteo, loteria, user
  await prisma.activityLog.deleteMany();
  await prisma.ticketCounter.deleteMany();

  await prisma.restrictionRule.deleteMany();
  await prisma.userMultiplierOverride.deleteMany();

  await prisma.loteriaMultiplier.deleteMany();
  await prisma.sorteo.deleteMany();

  await prisma.ventana.deleteMany();         // depende de banca
  await prisma.banca.deleteMany();
  await prisma.loteria.deleteMany();

  await prisma.user.deleteMany();
}
