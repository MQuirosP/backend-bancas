/**
 * Tests para evaluación de sorteos con extraMultiplierId OPCIONAL
 *
 * Este archivo cubre los casos relacionados con el fix que permite
 * evaluar sorteos sin extraMultiplierId, incluso cuando hay jugadas
 * REVENTADO apostadas al número ganador.
 *
 * Escenarios principales:
 * 1. Sorteo sin extraMultiplierId (multiplicador no sale)
 * 2. Sorteo con extraMultiplierId (multiplicador sale)
 * 3. Tickets mixtos (NUMERO + REVENTADO) sin multiplicador
 * 4. Verificar que extraMultiplierX se guarda como 0 cuando no viene
 * 5. Verificar que jugadas REVENTADO NO ganan cuando extraMultiplierId no viene
 */

import prisma from "../../src/core/prismaClient";
import { resetDatabase } from "../tickets/helpers/resetDatabase";
import { Role, SorteoStatus, BetType } from "@prisma/client";
import { SorteoService } from "../../src/api/v1/services/sorteo.service";
import TicketRepository from "../../src/repositories/ticket.repository";

jest.setTimeout(30000);

describe("🎯 Sorteo evaluate with OPTIONAL extraMultiplierId", () => {
  const adminId = "eeae221a-abe5-4f51-b148-927b450c551c";
  const loteriaId = "4be00dab-6d99-4c43-8a2b-fb560a81af2f";
  const bancaId = "226f0795-ccb2-4780-aa3f-9e328fc8ae46";
  const ventanaId = "f9643401-acba-43a1-9596-8c4d1d78e774";
  const vendedorId = "1d686b42-3a1b-42d1-9417-c229c42cd067";
  const baseMultiplierId = "8c81e1b4-556c-451f-946e-2a7f8dda745f";
  const extraMultiplierId = "28142e3a-c2ed-43d1-bc9e-bbb87c0beb1c";

  beforeAll(async () => {
    await resetDatabase();

    // Crear usuario admin
    await prisma.user.create({
      data: {
        id: adminId,
        username: "admin-optional",
        name: "Admin Optional",
        email: "admin@optional.test",
        password: "hashed",
        role: Role.ADMIN,
        isActive: true,
      },
    });

    // Crear banca
    await prisma.banca.create({
      data: {
        id: bancaId,
        code: "B-OPTIONAL",
        name: "Banca Optional Test"
      },
    });

    // Crear ventana
    await prisma.ventana.create({
      data: {
        id: ventanaId,
        code: "V-OPTIONAL",
        name: "Ventana Optional Test",
        bancaId,
        commissionMarginX: 0.1,
      },
    });

    // Crear vendedor
    await prisma.user.create({
      data: {
        id: vendedorId,
        username: "seller-optional",
        name: "Vendedor Optional",
        email: "seller@optional.test",
        password: "hashed",
        role: Role.VENDEDOR,
        ventanaId,
        isActive: true,
      },
    });

    // Crear lotería (con REVENTADO habilitado en rulesJson)
    await prisma.loteria.create({
      data: {
        id: loteriaId,
        name: "Lotería Optional Test",
        isActive: true,
        rulesJson: {
          reventadoConfig: {
            enabled: true,
            requiresMatchingNumber: false
          }
        }
      },
    });

    // Crear multiplicadores
    await prisma.loteriaMultiplier.create({
      data: {
        id: baseMultiplierId,
        loteriaId,
        name: "Base X2",
        valueX: 2,
        isActive: true,
        kind: "NUMERO",
      },
    });

    await prisma.loteriaMultiplier.create({
      data: {
        id: extraMultiplierId,
        loteriaId,
        name: "Reventado X5",
        valueX: 5,
        isActive: true,
        kind: "REVENTADO",
      },
    });

    // Config banca-loteria
    await prisma.bancaLoteriaSetting.create({
      data: {
        bancaId,
        loteriaId,
        baseMultiplierX: 2,
        maxTotalPerSorteo: 100000
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("Caso 1: Evaluación SIN extraMultiplierId (multiplicador NO sale)", () => {
    const sorteoId = "2075ca06-45fc-4057-adfa-c5669f3b0d56";

    beforeAll(async () => {
      // Crear sorteo y abrirlo
      await prisma.sorteo.create({
        data: {
          id: sorteoId,
          name: "Sorteo Sin Extra Mul",
          loteriaId,
          scheduledAt: new Date(),
          status: SorteoStatus.SCHEDULED,
        },
      });

      await prisma.sorteo.update({
        where: { id: sorteoId },
        data: { status: SorteoStatus.OPEN },
      });

      // Crear tickets:
      // - 1 con NUMERO "25"
      // - 1 con REVENTADO "25"
      await TicketRepository.create(
        {
          loteriaId,
          sorteoId,
          ventanaId,
          jugadas: [{ type: "NUMERO", number: "25", amount: 100 }],
        },
        vendedorId
      );

      await TicketRepository.create(
        {
          loteriaId,
          sorteoId,
          ventanaId,
          jugadas: [{ type: "REVENTADO", number: "25", reventadoNumber: "25", amount: 50 }],
        },
        vendedorId
      );
    });

    it("debe permitir evaluar sin extraMultiplierId incluso con jugadas REVENTADO", async () => {
      // Este es el caso que fallaba antes del fix
      const sorteo = await SorteoService.evaluate(
        sorteoId,
        { winningNumber: "25" }, // Sin extraMultiplierId
        adminId
      );

      expect(sorteo).toBeDefined();
      expect(sorteo?.status).toBe(SorteoStatus.EVALUATED);
      expect(sorteo?.winningNumber).toBe("25");
    });

    it("debe guardar extraMultiplierX como 0 cuando no viene extraMultiplierId", async () => {
      const sorteo = await prisma.sorteo.findUnique({
        where: { id: sorteoId },
      });

      expect(sorteo?.extraMultiplierId).toBeNull();
      expect(sorteo?.extraMultiplierX).toBe(0);
      expect(sorteo?.extraOutcomeCode).toBeNull();
    });

    it("debe marcar jugada NUMERO como ganadora", async () => {
      const jugadaNumero = await prisma.jugada.findFirst({
        where: {
          ticket: { sorteoId },
          type: BetType.NUMERO,
          number: "25",
          isActive: true,
        },
      });

      expect(jugadaNumero).toBeDefined();
      expect(jugadaNumero?.isWinner).toBe(true);
      expect(jugadaNumero?.finalMultiplierX).toBe(2); // Base multiplier
      expect(jugadaNumero?.payout).toBeCloseTo(100 * 2, 2); // 200
    });

    it("debe marcar jugada REVENTADO como NO ganadora", async () => {
      const jugadaReventado = await prisma.jugada.findFirst({
        where: {
          ticket: { sorteoId },
          type: BetType.REVENTADO,
          reventadoNumber: "25",
          isActive: true,
        },
      });

      expect(jugadaReventado).toBeDefined();
      expect(jugadaReventado?.isWinner).toBe(false);
      expect(jugadaReventado?.payout).toBeNull(); // No se calcula payout
    });

    it("debe calcular correctamente totalPayout del ticket (solo NUMERO)", async () => {
      const tickets = await prisma.ticket.findMany({
        where: { sorteoId },
        include: { jugadas: true },
      });

      const ticketGanador = tickets.find(t => t.isWinner);

      expect(ticketGanador).toBeDefined();
      expect(ticketGanador?.totalPayout).toBeCloseTo(200, 2); // Solo la jugada NUMERO
      expect(ticketGanador?.remainingAmount).toBeCloseTo(200, 2);
    });
  });

  describe("Caso 2: Evaluación CON extraMultiplierId (multiplicador SÍ sale)", () => {
    const sorteoId = "f452be0b-bd36-443c-bda9-d540bc9e3923";

    beforeAll(async () => {
      // Crear sorteo y abrirlo
      await prisma.sorteo.create({
        data: {
          id: sorteoId,
          name: "Sorteo Con Extra Mul",
          loteriaId,
          scheduledAt: new Date(),
          status: SorteoStatus.SCHEDULED,
        },
      });

      await prisma.sorteo.update({
        where: { id: sorteoId },
        data: { status: SorteoStatus.OPEN },
      });

      // Crear tickets
      await TicketRepository.create(
        {
          loteriaId,
          sorteoId,
          ventanaId,
          jugadas: [{ type: "NUMERO", number: "33", amount: 100 }],
        },
        vendedorId
      );

      await TicketRepository.create(
        {
          loteriaId,
          sorteoId,
          ventanaId,
          jugadas: [{ type: "REVENTADO", number: "33", reventadoNumber: "33", amount: 50 }],
        },
        vendedorId
      );
    });

    it("debe permitir evaluar con extraMultiplierId", async () => {
      const sorteo = await SorteoService.evaluate(
        sorteoId,
        {
          winningNumber: "33",
          extraMultiplierId, // Incluye el multiplicador
          extraOutcomeCode: "REVENTADO X5",
        },
        adminId
      );

      expect(sorteo).toBeDefined();
      expect(sorteo?.status).toBe(SorteoStatus.EVALUATED);
      expect(sorteo?.winningNumber).toBe("33");
    });

    it("debe guardar extraMultiplierId y extraMultiplierX correctamente", async () => {
      const sorteo = await prisma.sorteo.findUnique({
        where: { id: sorteoId },
      });

      expect(sorteo?.extraMultiplierId).toBe(extraMultiplierId);
      expect(sorteo?.extraMultiplierX).toBe(5);
      expect(sorteo?.extraOutcomeCode).toBe("REVENTADO X5");
    });

    it("debe marcar jugada NUMERO como ganadora", async () => {
      const jugadaNumero = await prisma.jugada.findFirst({
        where: {
          ticket: { sorteoId },
          type: BetType.NUMERO,
          number: "33",
          isActive: true,
        },
      });

      expect(jugadaNumero?.isWinner).toBe(true);
      expect(jugadaNumero?.finalMultiplierX).toBe(2);
      expect(jugadaNumero?.payout).toBeCloseTo(100 * 2, 2); // 200
    });

    it("debe marcar jugada REVENTADO como ganadora con extraX", async () => {
      const jugadaReventado = await prisma.jugada.findFirst({
        where: {
          ticket: { sorteoId },
          type: BetType.REVENTADO,
          reventadoNumber: "33",
          isActive: true,
        },
      });

      expect(jugadaReventado?.isWinner).toBe(true);
      expect(jugadaReventado?.finalMultiplierX).toBe(5); // Extra multiplier
      expect(jugadaReventado?.payout).toBeCloseTo(50 * 5, 2); // 250
      expect(jugadaReventado?.multiplierId).toBe(extraMultiplierId);
    });

    it("debe calcular correctamente totalPayout del ticket (NUMERO + REVENTADO)", async () => {
      const tickets = await prisma.ticket.findMany({
        where: { sorteoId },
        include: { jugadas: true },
      });

      // Ambos tickets deben ser ganadores
      const ticketsGanadores = tickets.filter(t => t.isWinner);
      expect(ticketsGanadores.length).toBe(2);

      const totalPayouts = ticketsGanadores.reduce((sum, t) => sum + (t.totalPayout || 0), 0);
      expect(totalPayouts).toBeCloseTo(200 + 250, 2); // 450
    });
  });

  describe("Caso 3: Ticket con MÚLTIPLES jugadas mixtas sin multiplicador", () => {
    const sorteoId = "0275cce7-7caf-41a2-8973-d62c7aa4b34d";

    beforeAll(async () => {
      // Crear sorteo y abrirlo
      await prisma.sorteo.create({
        data: {
          id: sorteoId,
          name: "Sorteo Jugadas Mixtas",
          loteriaId,
          scheduledAt: new Date(),
          status: SorteoStatus.SCHEDULED,
        },
      });

      await prisma.sorteo.update({
        where: { id: sorteoId },
        data: { status: SorteoStatus.OPEN },
      });

      // Crear ticket con múltiples jugadas:
      // - 2 NUMERO (una gana "45", otra no "46")
      // - 2 REVENTADO (una al número ganador "45", otra no "46")
      await TicketRepository.create(
        {
          loteriaId,
          sorteoId,
          ventanaId,
          jugadas: [
            { type: "NUMERO", number: "45", amount: 20 },
            { type: "NUMERO", number: "46", amount: 30 },
            { type: "REVENTADO", number: "45", reventadoNumber: "45", amount: 10 },
            { type: "REVENTADO", number: "46", reventadoNumber: "46", amount: 15 },
          ],
        },
        vendedorId
      );
    });

    it("debe evaluar correctamente con número ganador 45 sin extraMultiplierId", async () => {
      const sorteo = await SorteoService.evaluate(
        sorteoId,
        { winningNumber: "45" }, // Sin multiplicador extra
        adminId
      );

      expect(sorteo?.status).toBe(SorteoStatus.EVALUATED);
      expect(sorteo?.extraMultiplierX).toBe(0);
    });

    it("debe marcar solo NUMERO '45' como ganadora", async () => {
      const jugadas = await prisma.jugada.findMany({
        where: {
          ticket: { sorteoId },
          isActive: true,
        },
        orderBy: { createdAt: "asc" },
      });

      expect(jugadas.length).toBe(4);

      const numero45 = jugadas.find(j => j.type === "NUMERO" && j.number === "45");
      const numero46 = jugadas.find(j => j.type === "NUMERO" && j.number === "46");
      const reventado45 = jugadas.find(j => j.type === "REVENTADO" && j.reventadoNumber === "45");
      const reventado46 = jugadas.find(j => j.type === "REVENTADO" && j.reventadoNumber === "46");

      // Solo NUMERO 45 debe ganar
      expect(numero45?.isWinner).toBe(true);
      expect(numero45?.payout).toBeCloseTo(20 * 2, 2); // 40

      // Resto no gana
      expect(numero46?.isWinner).toBe(false);
      expect(reventado45?.isWinner).toBe(false);
      expect(reventado46?.isWinner).toBe(false);
    });

    it("debe calcular totalPayout solo con jugadas ganadoras", async () => {
      const ticket = await prisma.ticket.findFirst({
        where: { sorteoId },
      });

      expect(ticket?.isWinner).toBe(true);
      expect(ticket?.totalPayout).toBeCloseTo(40, 2); // Solo la jugada NUMERO 45
    });
  });

  describe("Caso 4: Sorteo con REVENTADO pero número ganador diferente", () => {
    const sorteoId = "9bf71ae9-e15c-4a03-991e-49cd25977fd2";

    beforeAll(async () => {
      // Crear sorteo y abrirlo
      await prisma.sorteo.create({
        data: {
          id: sorteoId,
          name: "Sorteo Número Diferente",
          loteriaId,
          scheduledAt: new Date(),
          status: SorteoStatus.SCHEDULED,
        },
      });

      await prisma.sorteo.update({
        where: { id: sorteoId },
        data: { status: SorteoStatus.OPEN },
      });

      // Crear tickets con jugadas a "50"
      await TicketRepository.create(
        {
          loteriaId,
          sorteoId,
          ventanaId,
          jugadas: [
            { type: "NUMERO", number: "50", amount: 20 },
            { type: "REVENTADO", number: "50", reventadoNumber: "50", amount: 10 },
          ],
        },
        vendedorId
      );
    });

    it("debe evaluar sin problemas cuando número ganador es diferente", async () => {
      // Gana el 99, no el 50
      const sorteo = await SorteoService.evaluate(
        sorteoId,
        { winningNumber: "99" }, // Ninguna jugada apostó a esto
        adminId
      );

      expect(sorteo?.status).toBe(SorteoStatus.EVALUATED);
      expect(sorteo?.winningNumber).toBe("99");
      expect(sorteo?.extraMultiplierX).toBe(0);
    });

    it("no debe marcar ninguna jugada como ganadora", async () => {
      const jugadas = await prisma.jugada.findMany({
        where: {
          ticket: { sorteoId },
          isActive: true,
        },
      });

      expect(jugadas.every(j => !j.isWinner)).toBe(true);
      expect(jugadas.every(j => j.payout === null)).toBe(true);
    });

    it("debe marcar ticket como no ganador", async () => {
      const ticket = await prisma.ticket.findFirst({
        where: { sorteoId },
      });

      expect(ticket?.isWinner).toBe(false);
      expect(ticket?.totalPayout).toBe(0); // Se inicializa en 0, no null
    });
  });

  describe("Caso 5: Múltiples tickets con REVENTADO, sin multiplicador", () => {
    const sorteoId = "08ce98fa-5675-4a7c-b147-528607a4c2ec";

    beforeAll(async () => {
      // Crear sorteo y abrirlo
      await prisma.sorteo.create({
        data: {
          id: sorteoId,
          name: "Sorteo Múltiples REVENTADO",
          loteriaId,
          scheduledAt: new Date(),
          status: SorteoStatus.SCHEDULED,
        },
      });

      await prisma.sorteo.update({
        where: { id: sorteoId },
        data: { status: SorteoStatus.OPEN },
      });

      // Crear 3 tickets diferentes, todos con REVENTADO a "77"
      for (let i = 0; i < 3; i++) {
        await TicketRepository.create(
          {
            loteriaId,
            sorteoId,
            ventanaId,
            jugadas: [
              { type: "REVENTADO", number: "77", reventadoNumber: "77", amount: 25 + i * 5 },
            ],
          },
          vendedorId
        );
      }
    });

    it("debe evaluar sin extraMultiplierId con múltiples tickets REVENTADO", async () => {
      const sorteo = await SorteoService.evaluate(
        sorteoId,
        { winningNumber: "77" },
        adminId
      );

      expect(sorteo?.status).toBe(SorteoStatus.EVALUATED);
      expect(sorteo?.extraMultiplierX).toBe(0);
    });

    it("ninguna jugada REVENTADO debe ganar", async () => {
      const jugadasReventado = await prisma.jugada.findMany({
        where: {
          ticket: { sorteoId },
          type: BetType.REVENTADO,
          isActive: true,
        },
      });

      expect(jugadasReventado.length).toBe(3);
      expect(jugadasReventado.every(j => !j.isWinner)).toBe(true);
    });

    it("ningún ticket debe ser ganador", async () => {
      const tickets = await prisma.ticket.findMany({
        where: { sorteoId },
      });

      expect(tickets.length).toBe(3);
      expect(tickets.every(t => !t.isWinner)).toBe(true);
    });
  });

  describe("Caso 6: Regresión - El error original", () => {
    const sorteoId = "ecbe6a86-fb0f-49cf-af92-843080001eb1";

    beforeAll(async () => {
      // Crear sorteo y abrirlo
      await prisma.sorteo.create({
        data: {
          id: sorteoId,
          name: "Sorteo Regression Test",
          loteriaId,
          scheduledAt: new Date(),
          status: SorteoStatus.SCHEDULED,
        },
      });

      await prisma.sorteo.update({
        where: { id: sorteoId },
        data: { status: SorteoStatus.OPEN },
      });

      // Crear ticket con REVENTADO
      await TicketRepository.create(
        {
          loteriaId,
          sorteoId,
          ventanaId,
          jugadas: [
            { type: "REVENTADO", number: "88", reventadoNumber: "88", amount: 100 },
          ],
        },
        vendedorId
      );
    });

    it("NO debe lanzar error 'Debes proporcionar extraMultiplierId'", async () => {
      // Este era el error original que reportaste
      await expect(
        SorteoService.evaluate(
          sorteoId,
          { winningNumber: "88" }, // Sin extraMultiplierId
          adminId
        )
      ).resolves.not.toThrow();
    });

    it("debe completar la evaluación exitosamente", async () => {
      const sorteo = await prisma.sorteo.findUnique({
        where: { id: sorteoId },
      });

      expect(sorteo?.status).toBe(SorteoStatus.EVALUATED);
      expect(sorteo?.winningNumber).toBe("88");
      expect(sorteo?.extraMultiplierX).toBe(0);
      expect(sorteo?.extraMultiplierId).toBeNull();
    });
  });

  describe("Caso 7: Validaciones de extraMultiplierId cuando SÍ se proporciona", () => {
    const sorteoId = "d069a41d-d3bb-484c-8edd-d31ea8a90f22";

    beforeAll(async () => {
      await prisma.sorteo.create({
        data: {
          id: sorteoId,
          name: "Sorteo Validation Test",
          loteriaId,
          scheduledAt: new Date(),
          status: SorteoStatus.OPEN,
        },
      });
    });

    it("debe rechazar extraMultiplierId inválido (UUID no existe)", async () => {
      await expect(
        SorteoService.evaluate(
          sorteoId,
          {
            winningNumber: "10",
            extraMultiplierId: "00000000-0000-0000-0000-000000000000",
          },
          adminId
        )
      ).rejects.toThrow("extraMultiplierId inválido o inactivo");
    });

    it("debe rechazar extraMultiplierId de otra lotería", async () => {
      // Crear otra lotería y multiplicador
      const otraLoteriaId = "05bccea8-f539-4ac3-83a6-1708cbea8f9f";
      const otroMultiplierId = "fd2c2335-2aff-47b0-ae96-fe2d521c4253";

      await prisma.loteria.create({
        data: { id: otraLoteriaId, name: "Otra Lotería", isActive: true },
      });

      await prisma.loteriaMultiplier.create({
        data: {
          id: otroMultiplierId,
          loteriaId: otraLoteriaId,
          name: "Otro Reventado",
          valueX: 3,
          isActive: true,
          kind: "REVENTADO",
        },
      });

      await expect(
        SorteoService.evaluate(
          sorteoId,
          {
            winningNumber: "10",
            extraMultiplierId: otroMultiplierId,
          },
          adminId
        )
      ).rejects.toThrow("extraMultiplierId no pertenece a la lotería del sorteo");
    });

    it("debe rechazar multiplicador que no es de tipo REVENTADO", async () => {
      // baseMultiplierId es de tipo NUMERO, no REVENTADO
      await expect(
        SorteoService.evaluate(
          sorteoId,
          {
            winningNumber: "10",
            extraMultiplierId: baseMultiplierId,
          },
          adminId
        )
      ).rejects.toThrow("extraMultiplierId no es de tipo REVENTADO");
    });
  });
});
