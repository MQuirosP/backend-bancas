import prisma from "../../src/core/prismaClient";
import { Role, SorteoStatus } from "@prisma/client";
import { SorteoService } from "../../src/api/v1/services/sorteo.service";
import { AppError } from "../../src/core/errors";
import { resetDatabase } from "../tickets/helpers/resetDatabase";
import { TEST_IDS } from "../helpers/testIds";

jest.setTimeout(20000);

describe("🛡️ SorteoService.evaluate state guards", () => {
  const adminId = TEST_IDS.ADMIN_ID;
  const loteriaId = TEST_IDS.LOTERIA_ID;
  const sorteoScheduledId = "a5f8e2d1-4c3b-4a7e-9d1f-3b4c5d6e7f8a";
  const sorteoOpenId = "b6a9f3e2-5d4c-4b8f-0e2a-4c5d6e7f8a9b";
  const sorteoClosedId = "c7b0a4f3-6e5d-4c9a-1f3b-5d6e7f8a9b0c";

  beforeAll(async () => {
    await resetDatabase();

    await prisma.user.upsert({
      where: { id: adminId },
      update: {},
      create: {
        id: adminId,
        email: "admin@eval.guards",
        name: "Admin Eval Guards",
        username: "admin-eval-guards",
        password: "hashed",
        role: Role.ADMIN,
        isActive: true,
      },
    });

    await prisma.loteria.create({
      data: { id: loteriaId, name: "Lotería EvalGuards", isActive: true },
    });

    await prisma.sorteo.create({
      data: {
        id: sorteoScheduledId,
        name: "Sorteo Scheduled",
        loteriaId,
        scheduledAt: new Date(),
        status: SorteoStatus.SCHEDULED,
      },
    });

    await prisma.sorteo.create({
      data: {
        id: sorteoOpenId,
        name: "Sorteo Open",
        loteriaId,
        scheduledAt: new Date(),
        status: SorteoStatus.OPEN,
      },
    });

    await prisma.sorteo.create({
      data: {
        id: sorteoClosedId,
        name: "Sorteo Closed",
        loteriaId,
        scheduledAt: new Date(),
        status: SorteoStatus.CLOSED,
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("should REJECT evaluate when status is SCHEDULED (must be OPEN)", async () => {
    await expect(
      SorteoService.evaluate(
        sorteoScheduledId,
        { winningNumber: "22" },
        adminId
      )
    ).rejects.toThrow(AppError);
  });

  it("should ALLOW evaluate when status is OPEN", async () => {
    const s = await SorteoService.evaluate(
      sorteoOpenId,
      { winningNumber: "22" },
      adminId
    );
    expect(s?.status).toBe(SorteoStatus.EVALUATED);
    expect(s?.winningNumber).toBe("22");
  });

  it("should REJECT evaluate when status is CLOSED", async () => {
    await expect(
      SorteoService.evaluate(
        sorteoClosedId,
        { winningNumber: "22" },
        adminId
      )
    ).rejects.toThrow(AppError);
  });
});
