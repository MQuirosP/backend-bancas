// tests/tickets/restrictionRules.test.ts
import prisma from "../../src/core/prismaClient";
import TicketRepository from "../../src/repositories/ticket.repository";
import { Role, SorteoStatus } from "@prisma/client";
import { resetDatabase } from "./helpers/resetDatabase";
import { TEST_IDS } from "../helpers/testIds";

jest.setTimeout(20000);

describe("🎯 RestrictionRule pipeline", () => {
  const userId = TEST_IDS.VENDEDOR_ID;
  const bancaId = TEST_IDS.BANCA_ID;
  const ventanaId = TEST_IDS.VENTANA_ID;
  const loteriaId = TEST_IDS.LOTERIA_ID;
  const sorteoId = TEST_IDS.SORTEO_ID;
  const baseMultiplierId = TEST_IDS.BASE_MULTIPLIER_ID;

  beforeAll(async () => {
    await resetDatabase();

    // 👤 Usuario vendedor (con username requerido)
    await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: {
        id: userId,
        email: "rule@test.com",
        username: "rule.vendedor",
        name: "Vendedor Restricciones",
        password: "hashedpassword",
        role: Role.VENDEDOR,
        isActive: true,
      },
    });

    // 🏦 Banca
    await prisma.banca.create({
      data: {
        id: bancaId,
        code: `B-${Date.now()}`,
        name: "Banca Regla",
        isActive: true,
      },
    });

    // 🪟 Ventana
    await prisma.ventana.create({
      data: {
        id: ventanaId,
        code: `V-${Date.now()}`,
        name: "Ventana Regla",
        bancaId,
        commissionMarginX: 0.1,
        isActive: true,
      },
    });

    // 🎟️ Lotería
    await prisma.loteria.create({
      data: { id: loteriaId, name: "Lotería Prueba", isActive: true },
    });

    // ⚙️ BancaLoteriaSetting (repo resuelve BaseX dentro de la TX)
    await prisma.bancaLoteriaSetting.create({
      data: {
        bancaId,
        loteriaId,
        baseMultiplierX: 2, // X efectivo si no hay override de usuario
      },
    });

    // ✖️ LoteriaMultiplier "Base" (el repo lo busca por name="Base")
    await prisma.loteriaMultiplier.create({
      data: {
        id: baseMultiplierId,
        name: "Base",
        valueX: 2,
        loteriaId,
        isActive: true,
        kind: "NUMERO",
      },
    });

    // 🗓️ Sorteo ABIERTO (requerido por el repo)
    await prisma.sorteo.create({
      data: {
        id: sorteoId,
        name: "Sorteo Test",
        loteriaId,
        scheduledAt: new Date(),
        status: SorteoStatus.OPEN,
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("should block ticket exceeding maxTotal for user", async () => {
    // 🔒 Regla que limita el total por ticket para este usuario
    await prisma.restrictionRule.create({
      data: {
        userId,
        maxTotal: 200, // límite por ticket
      },
    });

    // Payload que excede el límite (300 > 200)
    const baseTicket = {
      loteriaId,
      sorteoId,
      ventanaId,
      totalAmount: 300, // mantén coherente con la suma de jugadas
      jugadas: [
        {
          type: "NUMERO" as const,
          number: "22",
          amount: 300,
          multiplierId: baseMultiplierId, // el repo lo sobreescribe a "Base" igualmente
          finalMultiplierX: 2,            // el repo congela X efectivo interno
        },
      ],
    };

    await expect(TicketRepository.create(baseTicket as any, userId)).rejects.toThrow(
      /exceeded|excedido|maxTotal/i
    );
  });
});
