import prisma from "../../src/core/prismaClient";
import { resetDatabase } from "../tickets/helpers/resetDatabase";
import { SorteoService } from "../../src/api/v1/services/sorteo.service";
import { Role, SorteoStatus } from "@prisma/client";
import { TEST_IDS } from "../helpers/testIds";

jest.setTimeout(20000);

describe("🗓️ Sorteo lifecycle", () => {
  const admin = TEST_IDS.ADMIN_ID;
  const loteriaId = TEST_IDS.LOTERIA_ID;
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

  // tests/sorteos/sorteo.lifecycle.test.ts

  it("create -> open -> evaluate (EVALUATED es terminal)", async () => {
    const created = await SorteoService.create(
      { loteriaId, scheduledAt: new Date(), name: "Sorteo LC Eval Terminal" },
      admin
    );
    const sorteoId2 = created.id;
    expect(created.status).toBe(SorteoStatus.SCHEDULED);

    const opened2 = await SorteoService.open(sorteoId2, admin);
    expect(opened2.status).toBe(SorteoStatus.OPEN);

    // evaluar y NO cerrar
    const evaluated2 = await SorteoService.evaluate(
      sorteoId2,
      { winningNumber: "22" },
      admin
    );
    expect(evaluated2?.status).toBe(SorteoStatus.EVALUATED);
  });
});
