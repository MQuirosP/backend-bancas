// tests/tickets/helpers/resetDatabase.ts
import prisma from "../../../src/core/prismaClient";

export async function resetDatabase() {
  // NO metas esto en prisma.$transaction; es un statement atómico en PG
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ActivityLog",
      "TicketPayment",
      "Jugada",
      "Ticket",
      "RestrictionRule",
      "UserMultiplierOverride",
      "LoteriaMultiplier",
      "Sorteo",
      "Loteria",
      "User",
      "Ventana",
      "Banca",
      "TicketCounter",
      "RefreshToken"
    RESTART IDENTITY CASCADE;
  `);
}
