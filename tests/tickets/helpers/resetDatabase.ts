import prisma from '../../../src/core/prismaClient';

export async function resetDatabase() {
  // 1) Transaccional para consistencia
  await prisma.$transaction(async (tx) => {
    // Pagos y actividades
    await tx.ticketPayment.deleteMany({});
    await tx.activityLog.deleteMany({});
    await tx.refreshToken.deleteMany({}); // por si existe

    // Jugadas y tickets
    await tx.jugada.deleteMany({});
    await tx.ticket.deleteMany({});

    // Reglas / overrides
    await tx.restrictionRule.deleteMany({});
    await tx.userMultiplierOverride.deleteMany({});

    // Sorteos (dependen de lotería)
    await tx.sorteo.deleteMany({});

    // Multipliers y settings (dependen de lotería/banca)
    await tx.loteriaMultiplier.deleteMany({});
    await tx.bancaLoteriaSetting.deleteMany({});

    // Ventanas y usuarios (usuarios dependen de ventana)
    await tx.user.updateMany({ data: { ventanaId: null } }); // por si hay FK
    await tx.user.deleteMany({});
    await tx.ventana.deleteMany({});

    // Loterías y bancas
    await tx.loteria.deleteMany({});
    await tx.banca.deleteMany({});

    // (Opcional legado)
    await tx.ticketCounter.deleteMany({}).catch(() => {});
  });
}
