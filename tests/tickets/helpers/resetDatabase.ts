import prisma from "../../../src/core/prismaClient";

export async function resetDatabase() {
  await prisma.refreshToken.deleteMany();
  await prisma.activityLog.deleteMany();
  await prisma.jugada.deleteMany();
  await prisma.ticket.deleteMany();
  await prisma.loteriaMultiplier.deleteMany();
  await prisma.sorteo.deleteMany();
  await prisma.ventana.deleteMany();
  await prisma.banca.deleteMany();
  await prisma.loteria.deleteMany();
  await prisma.user.deleteMany();
}
