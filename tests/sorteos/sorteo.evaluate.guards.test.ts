import prisma from "../../src/core/prismaClient";
import { Role, SorteoStatus } from "@prisma/client";
import { SorteoService } from "../../src/api/v1/services/sorteo.service";
import { AppError } from "../../src/core/errors";
import { resetDatabase } from "../tickets/helpers/resetDatabase";

jest.setTimeout(20000);

describe("🛡️ SorteoService.evaluate state guards", () => {
  const adminId = "admin-eval-guards";
  const loteriaId = "lot-eval-guards";
  const sorteoScheduledId = "sor-eval-scheduled";
  const sorteoOpenId = "sor-eval-open";
  const sorteoClosedId = "sor-eval-closed";

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
