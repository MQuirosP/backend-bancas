import prisma from "../../src/core/prismaClient";
import { resetDatabase } from "../tickets/helpers/resetDatabase";
import { Role, SorteoStatus } from "@prisma/client";
import { SorteoService } from "../../src/api/v1/services/sorteo.service";

jest.setTimeout(30000);

describe("🎲 Sorteo evaluate flow", () => {
  const userAdmin = "admin-user";
  const loteriaId = "lot-eval";
  const sorteoId = "sor-eval";
  const ventanaId = "ven-eval";
  const bancaId = "ban-eval";
  const vendedorId = "vend-eval";
  const baseMultiplierId = "mul-base";
  const extraMultiplierId = "mul-extra"; // para REVENTADO

  beforeAll(async () => {
    await resetDatabase();

    await prisma.user.create({
      data: {
        id: userAdmin,
        username: "admin",
        name: "Admin",
        password: "hashed",
        role: Role.ADMIN,
        isActive: true,
      },
    });

    await prisma.banca.create({
      data: { id: bancaId, code: "B-TEST", name: "Banca Test" },
    });

    await prisma.ventana.create({
      data: {
        id: ventanaId,
        code: "V-TEST",
        name: "Ventana Test",
        bancaId,
        commissionMarginX: 0.1,
      },
    });

    await prisma.user.create({
      data: {
        id: vendedorId,
        username: "seller",
        name: "Vendedor",
        password: "hashed",
        role: Role.VENDEDOR,
        ventanaId,
      },
    });

    await prisma.loteria.create({
      data: { id: loteriaId, name: "Lotería Eval" },
    });

    // Base y Extra
    await prisma.loteriaMultiplier.create({
      data: { id: baseMultiplierId, loteriaId, name: "Base", valueX: 2, isActive: true },
    });
    await prisma.loteriaMultiplier.create({
      data: { id: extraMultiplierId, loteriaId, name: "Reventado X5", valueX: 5, isActive: true, kind: "REVENTADO" },
    });

    // Config banca-loteria para congelar X base en venta
    await prisma.bancaLoteriaSetting.create({
      data: { bancaId, loteriaId, baseMultiplierX: 2, maxTotalPerSorteo: 100000 },
    });

    // Crear sorteo (SCHEDULED) y abrirlo
    const created = await prisma.sorteo.create({
      data: {
        id: sorteoId,
        name: "Sorteo Eval",
        loteriaId,
        scheduledAt: new Date(),
        status: SorteoStatus.SCHEDULED,
      },
    });
    expect(created.id).toBe(sorteoId);

    await prisma.sorteo.update({
      where: { id: sorteoId },
      data: { status: SorteoStatus.OPEN },
    });

    // Crear un par de tickets:
    // - Ticket A con NUMERO "12" (gana si 12)
    // - Ticket B con REVENTADO "12" (gana si 12 y viene extraMultiplier)
    const TicketRepository = (await import("../../src/repositories/ticket.repository")).default;

    // NUMERO
    await TicketRepository.create(
      {
        loteriaId,
        sorteoId,
        ventanaId,
        jugadas: [{ type: "NUMERO", number: "12", amount: 10 }],
      },
      vendedorId
    );

    // REVENTADO
    await TicketRepository.create(
      {
        loteriaId,
        sorteoId,
        ventanaId,
        jugadas: [{ type: "REVENTADO", number: "12", reventadoNumber: "12", amount: 3 }],
      },
      vendedorId
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("evaluates paying NUMERO by finalMultiplierX and REVENTADO by extraMultiplierX snapshot", async () => {
    // evaluate con número 12 y extraMultiplierId (paga reventado)
    const s = await SorteoService.evaluate(
      sorteoId,
      { winningNumber: "12", extraMultiplierId },
      userAdmin
    );

    expect(s?.status).toBe(SorteoStatus.EVALUATED);
    expect(s?.winningNumber).toBe("12");
    expect(s?.extraMultiplierId).toBe(extraMultiplierId);
    expect(s?.extraMultiplierX).toBe(5);

    // Verificar jugadas
    const jugadas = await prisma.jugada.findMany({
      where: { ticket: { sorteoId }, isActive: true },
      orderBy: { createdAt: "asc" },
      select: {
        type: true,
        number: true,
        amount: true,
        finalMultiplierX: true,
        isWinner: true,
        payout: true,
      },
    });

    // Debe haber 2 jugadas (NUMERO y REVENTADO), ambas con number "12"
    expect(jugadas.length).toBe(2);

    const numero = jugadas.find(j => j.type === "NUMERO")!;
    const reventado = jugadas.find(j => j.type === "REVENTADO")!;

    // NUMERO: payout = amount * finalMultiplierX (2)
    expect(numero.isWinner).toBe(true);
    expect(numero.finalMultiplierX).toBe(2);
    expect(numero.payout).toBeCloseTo(10 * 2, 5);

    // REVENTADO: payout = amount * extraX (5)
    expect(reventado.isWinner).toBe(true);
    expect(reventado.finalMultiplierX).toBe(5);
    expect(reventado.payout).toBeCloseTo(3 * 5, 5);
  });
});
