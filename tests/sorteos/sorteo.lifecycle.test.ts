import prisma from "../../src/core/prismaClient";
import { resetDatabase } from "../tickets/helpers/resetDatabase";
import { SorteoService } from "../../src/api/v1/services/sorteo.service";
import { Role, SorteoStatus } from "@prisma/client";

jest.setTimeout(20000);

describe("🗓️ Sorteo lifecycle", () => {
  const admin = "admin-lc";
  const loteriaId = "lot-lc";
  let sorteoId = "";

  beforeAll(async () => {
    await resetDatabase();
    await prisma.user.create({
      data: {
        id: admin,
        username: "admin",
        name: "Admin",
        password: "hashed",
        role: Role.ADMIN,
      },
    });
    await prisma.loteria.create({
      data: { id: loteriaId, name: "Lotería LC" },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("create -> open -> close", async () => {
    const created = await SorteoService.create(
      { loteriaId, scheduledAt: new Date(), name: "Sorteo LC" },
      admin
    );
    sorteoId = created.id;
    expect(created.status).toBe(SorteoStatus.SCHEDULED);

    const opened = await SorteoService.open(sorteoId, admin);
    expect(opened.status).toBe(SorteoStatus.OPEN);

    const closed = await SorteoService.close(sorteoId, admin);
    expect(closed.status).toBe(SorteoStatus.CLOSED);
  });

  it("create -> open -> evaluate -> close", async () => {
    // create (SCHEDULED)
    const created = await SorteoService.create(
      {
        loteriaId,
        scheduledAt: new Date(),
        name: `Sorteo LC Eval ${Date.now()}`,
      },
      admin
    );
    expect(created.status).toBe(SorteoStatus.SCHEDULED);

    // open (OPEN)
    const opened = await SorteoService.open(created.id, admin);
    expect(opened.status).toBe(SorteoStatus.OPEN);

    // evaluate (EVALUATED) — sin reventado
    const evaluated = await SorteoService.evaluate(
      created.id,
      { winningNumber: "22", extraMultiplierId: null, extraOutcomeCode: null },
      admin
    );
    expect(evaluated?.status).toBe(SorteoStatus.EVALUATED);
    expect(evaluated?.winningNumber).toBe("22");

    // close (CLOSED)
    const closed = await SorteoService.close(created.id, admin);
    expect(closed.status).toBe(SorteoStatus.CLOSED);
  });
});
