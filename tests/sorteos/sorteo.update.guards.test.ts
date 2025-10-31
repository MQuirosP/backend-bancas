import prisma from "../../src/core/prismaClient";
import { Role, SorteoStatus } from "@prisma/client";
import { SorteoService } from "../../src/api/v1/services/sorteo.service";
import { resetDatabase } from "../tickets/helpers/resetDatabase";
import { TEST_IDS } from "../helpers/testIds";

jest.setTimeout(20000);

describe("🛡️ SorteoService.update guards", () => {
  const adminId = TEST_IDS.ADMIN_ID;
  const loteriaId = TEST_IDS.LOTERIA_ID;
  const sorteoId = TEST_IDS.SORTEO_ID;
  const extraMulId = TEST_IDS.EXTRA_MULTIPLIER_ID;

  beforeAll(async () => {
    await resetDatabase();

    // Admin necesario para ActivityLog
    await prisma.user.upsert({
      where: { id: adminId },
      update: {},
      create: {
        id: adminId,
        email: "admin@guards.test",
        name: "Admin Guards",
        username: "admin-guards",
        password: "hashed",
        role: Role.ADMIN,
        isActive: true,
      },
    });

    await prisma.loteria.create({
      data: { id: loteriaId, name: "Lotería UpdateGuards", isActive: true },
    });

    // Un multiplicador que intentaremos “forzar” vía update
    await prisma.loteriaMultiplier.create({
      data: {
        id: extraMulId,
        loteriaId,
        name: "x2",
        valueX: 2,
        isActive: true,
      },
    });

    await prisma.sorteo.create({
      data: {
        id: sorteoId,
        name: "Sorteo UpdateGuards",
        loteriaId,
        scheduledAt: new Date(),
        status: SorteoStatus.SCHEDULED,
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("should NOT allow update() to change status/winningNumber/extraMultiplier", async () => {
    // Intentamos pasar campos “no permitidos” en update
    const newDate = new Date(Date.now() + 60 * 60 * 1000);

    const updated = await SorteoService.update(
      sorteoId,
      {
        // lo único que debería aplicar el service es scheduledAt
        scheduledAt: newDate,

        // Estos NO deben surtir efecto en el repository (cortados por el service)
        status: SorteoStatus.OPEN,
        winningNumber: "12",
        extraOutcomeCode: "ANY",
        extraMultiplierId: extraMulId,
      } as any,
      adminId
    );

    expect(updated).toBeTruthy();

    const db = await prisma.sorteo.findUnique({
      where: { id: sorteoId },
      select: {
        scheduledAt: true,
        status: true,
        winningNumber: true,
        extraMultiplierId: true,
        extraOutcomeCode: true,
      },
    });

    // ✅ sólo cambió scheduledAt
    expect(db?.scheduledAt.getTime()).toBe(newDate.getTime());

    // ❌ NO debe haber cambiado el estado
    expect(db?.status).toBe(SorteoStatus.SCHEDULED);

    // ❌ NO debe haber establecido número ganador
    expect(db?.winningNumber).toBeNull();

    // ❌ NO debe haber conectado multiplicador extra
    expect(db?.extraMultiplierId).toBeNull();

    // ❌ Tampoco outcome code
    expect(db?.extraOutcomeCode).toBeNull();
  });
});
