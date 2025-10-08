import prisma from "../../src/core/prismaClient";
import TicketRepository from "../../src/repositories/ticket.repository";
import { Role } from "@prisma/client";
import { resetDatabase } from "./helpers/resetDatabase";

jest.setTimeout(20000);

describe("🎯 RestrictionRule pipeline", () => {
  const userId = "user-rule-test";
  const bancaId = "banca-rule";
  const ventanaId = "ventana-rule";
  const loteriaId = "loteria-rule";
  const sorteoId = "sorteo-rule";
  const multiplierId = "multiplier-rule";

  beforeAll(async () => {
    await resetDatabase();

    // 🔹 Crear usuario requerido por RestrictionRule
    await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: {
        id: userId,
        email: "rule@test.com",
        name: "Vendedor Restricciones",
        password: "hashedpassword",
        role: Role.VENDEDOR,
        isActive: true,
      },
    });

    // 🔹 Crear banca, ventana y dependencias mínimas
    await prisma.banca.create({
      data: {
        id: bancaId,
        code: `B-${Date.now()}`,
        name: "Banca Regla",
        isActive: true,
      },
    });

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

    await prisma.loteria.create({
      data: { id: loteriaId, name: "Lotería Prueba", isActive: true },
    });

    await prisma.sorteo.create({
      data: {
        id: sorteoId,
        name: "Sorteo Test",
        loteriaId,
        scheduledAt: new Date(),
        status: "OPEN", // ✅ Correcto para venta
      },
    });

    await prisma.loteriaMultiplier.create({
      data: {
        id: multiplierId,
        name: "x2",
        valueX: 2,
        loteriaId,
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("should block ticket exceeding maxTotal for user", async () => {
    // 🔹 Crear la regla de restricción para este usuario
    await prisma.restrictionRule.create({
      data: { userId, maxTotal: 200 },
    });

    const baseTicket = {
      loteriaId,
      sorteoId,
      ventanaId,
      totalAmount: 300, // excede el límite
      jugadas: [
        { number: "22", amount: 300, multiplierId, finalMultiplierX: 2 },
      ],
    };

    await expect(TicketRepository.create(baseTicket, userId)).rejects.toThrow(
      /exceeded/i
    );
  });
});
