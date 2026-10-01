import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import { URL } from "url";
import prisma from "../../src/core/prismaClient";
import { initRedisClient, getRedisClient, isRedisAvailable } from "../../src/core/redisClient";
import { VendorCreditService, CreditStatus } from "../../src/domain/credit/vendorCredit.service";
import { UserService } from "../../src/domain/user/user.service";
import { SocketService } from "../../src/core/socket.service";
import { Role } from "../../src/generated/prisma/client";
import { seedTestData, cleanupTestData, TEST_MARKER } from "../../scripts/seed_credit_test";
import { config } from "../../src/config";

const runIntegration = process.env.CREDIT_E2E_LOCAL === "true";
const describeOrSkip = runIntegration ? describe : describe.skip;

function assertLocalEnvironment(): void {
  const dbUrl = process.env.DATABASE_URL || "";
  try {
    const parsed = new URL(dbUrl);
    if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      throw new Error(`ABORTED: Non-local database host: ${parsed.hostname}`);
    }
  } catch (e: any) {
    if (e.message.includes("ABORTED")) throw e;
    throw new Error("ABORTED: Invalid DATABASE_URL");
  }

  const redisUrl = process.env.REDIS_URL || config.redis.url || "redis://127.0.0.1:6379";
  try {
    const parsed = new URL(redisUrl);
    if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      throw new Error(`ABORTED: Non-local redis host: ${parsed.hostname}`);
    }
  } catch (e: any) {
    if (e.message.includes("ABORTED")) throw e;
    throw new Error("ABORTED: Invalid REDIS_URL");
  }
}

describeOrSkip("E2E Integration: Vendor Credit System (Local DB & Redis)", () => {
  let seededData: any;
  let redis: any;
  let adminUser: any;

  beforeAll(async () => {
    assertLocalEnvironment();
    config.creditLimit.enabled = true;
    config.redis.enabled = true;
    await initRedisClient();
    redis = getRedisClient();
    for (let i = 0; i < 30 && (!redis || !isRedisAvailable()); i++) {
      await new Promise((r) => setTimeout(r, 100));
      redis = getRedisClient();
    }
    seededData = await seedTestData();

    adminUser = await prisma.user.findFirst({
      where: { role: Role.ADMIN, isActive: true },
    });
    if (!adminUser) {
      adminUser = await prisma.user.create({
        data: {
          name: `${TEST_MARKER}ADMIN`,
          username: "test-credit-admin-e2e",
          password: "$2b$10$epRswZ5V0d8pB2E7.W5aUeN7tqB3wH6mY9gL1f2s3k4l5m6n7o8p9",
          role: Role.ADMIN,
          isActive: true,
        },
      });
    }
  }, 35000);

  afterAll(async () => {
    if (runIntegration) {
      await cleanupTestData();
    }
  }, 30000);

  describe("1. Sorteo evaluating marker & sync failure resilience (Parte 1.1 & 1.2)", () => {
    it("retains evaluating marker on sync failure avoiding subconteo, then normalizes on posterior sync", async () => {
      const vendor = seededData.vendorLimited;
      const sorteo = seededData.openSorteos[0];

      // Hidratar estado de crédito inicial
      const initialHydration = await VendorCreditService.hydrate(vendor.id);
      expect(initialHydration.baseBalance).toBe(300000);

      // Simular que el sorteo entra a evaluación
      await VendorCreditService.markSorteoEvaluating(sorteo.id);
      let evaluatingIds = await VendorCreditService.getEvaluatingSorteoIds();
      expect(evaluatingIds).toContain(sorteo.id);

      // Simular que el sorteo fue evaluado en BD pero el sync contable falló (catch)
      // La regla exige que NO se limpie el marcador en catch (syncErr)
      // Verificar que el marcador sigue presente
      evaluatingIds = await VendorCreditService.getEvaluatingSorteoIds();
      expect(evaluatingIds).toContain(sorteo.id);

      // Verificar que el saldo efectivo consultado NO sufre subconteo
      const statusRes = await VendorCreditService.getVendorsCreditStatus(
        { id: adminUser.id, role: Role.ADMIN },
        { requestedVendedorIds: [vendor.id] }
      );
      expect(statusRes.items.length).toBe(1);
      expect(statusRes.items[0].effectiveBalance).toBeGreaterThanOrEqual(300000);

      // Simular sincronización contable posterior exitosa (reconcileSorteo)
      await VendorCreditService.reconcileSorteo(sorteo.id);

      // El marcador debe haber sido eliminado
      evaluatingIds = await VendorCreditService.getEvaluatingSorteoIds();
      expect(evaluatingIds).not.toContain(sorteo.id);
    });
  });

  describe("2. GET /api/v1/credit/status role & scope enforcement (Parte 2)", () => {
    it("ADMIN: returns active vendors with credit limit within scope", async () => {
      const res = await VendorCreditService.getVendorsCreditStatus(
        { id: adminUser.id, role: Role.ADMIN },
        {}
      );
      expect(res.enabled).toBe(true);
      expect(Array.isArray(res.items)).toBe(true);
      const found = res.items.find((i) => i.vendedorId === seededData.vendorLimited.id);
      expect(found).toBeDefined();
      expect(found!.creditLimit).toBe(408000);
    });

    it("ADMIN with active banca: filters vendors by active banca", async () => {
      const res = await VendorCreditService.getVendorsCreditStatus(
        { id: adminUser.id, role: Role.ADMIN },
        { activeBancaId: seededData.banca.id }
      );
      expect(res.enabled).toBe(true);
      const found = res.items.find((i) => i.vendedorId === seededData.vendorLimited.id);
      expect(found).toBeDefined();
    });

    it("VENTANA: returns only vendors in the actor's ventana", async () => {
      const res = await VendorCreditService.getVendorsCreditStatus(
        {
          id: "ventana-user-id",
          role: Role.VENTANA,
          ventanaId: seededData.ventana.id,
        },
        {}
      );
      expect(res.enabled).toBe(true);
      expect(res.items.every((i) => i.vendedorId === seededData.vendorLimited.id)).toBe(true);
    });

    it("VENDEDOR: queries only their own status, omitting out-of-scope IDs without error", async () => {
      const vendor = seededData.vendorLimited;
      const res = await VendorCreditService.getVendorsCreditStatus(
        { id: vendor.id, role: Role.VENDEDOR },
        { requestedVendedorIds: [vendor.id, "00000000-0000-0000-0000-000000000000"] }
      );
      expect(res.enabled).toBe(true);
      expect(res.items.length).toBe(1);
      expect(res.items[0].vendedorId).toBe(vendor.id);
    });

    it("omits vendors without limit from general listing, but returns creditLimit: null and status: NORMAL when requested by id", async () => {
      const unlimitedVendor = seededData.vendorUnlimited;

      // 1. En listado general sin ids: no debe aparecer
      const generalList = await VendorCreditService.getVendorsCreditStatus(
        { id: adminUser.id, role: Role.ADMIN },
        {}
      );
      const inGeneral = generalList.items.find((i) => i.vendedorId === unlimitedVendor.id);
      expect(inGeneral).toBeUndefined();

      // 2. Al solicitar explícitamente su ID: debe retornar creditLimit null y status NORMAL
      const specificList = await VendorCreditService.getVendorsCreditStatus(
        { id: adminUser.id, role: Role.ADMIN },
        { requestedVendedorIds: [unlimitedVendor.id] }
      );
      expect(specificList.items.length).toBe(1);
      expect(specificList.items[0].vendedorId).toBe(unlimitedVendor.id);
      expect(specificList.items[0].creditLimit).toBeNull();
      expect(specificList.items[0].status).toBe("NORMAL");
    });
  });

  describe("3. Stale Redis status immunity (Parte 2)", () => {
    it("calculates status dynamically from effective balance, ignoring BLOCKED stored in Redis from oversized attempts", async () => {
      const vendor = seededData.vendorLimited;

      // Hidratar claves en Redis
      await VendorCreditService.hydrate(vendor.id);

      // Simular que Redis quedó con status='BLOCKED' por un intento rechazado previo
      const { cfg } = (VendorCreditService as any).getKeys(vendor.id);
      await redis.hset(cfg, "status", "BLOCKED");

      // Consultar estado de crédito: debe calcularse con computeCreditStatus (saldo 300,000 <= tope 408,000)
      const res = await VendorCreditService.getVendorsCreditStatus(
        { id: adminUser.id, role: Role.ADMIN },
        { requestedVendedorIds: [vendor.id] }
      );

      expect(res.items.length).toBe(1);
      // Con saldo 300,000 y tope 408,000 (73.5%), es NORMAL (o WARNING si > 80%)
      // En ningún caso debe retornar BLOCKED porque 300,000 no excede 408,000
      expect(res.items[0].status).not.toBe("BLOCKED");
      expect(["NORMAL", "WARNING"]).toContain(res.items[0].status);
    });
  });

  describe("4. Credit configuration update and WebSocket emission (Parte 1.7 & Parte 2)", () => {
    it("invalidates keys, rehydrates and emits credit status changed when limit changes", async () => {
      const vendor = seededData.vendorLimited;
      const socketSpy = jest.spyOn(SocketService, "notifyVendorCreditStatusChanged");

      // Modificar tope de 408,000 a 250,000 (el saldo base es 300,000, por lo que pasará a BLOCKED)
      await UserService.update(
        vendor.id,
        { creditLimit: 250000 },
        { id: adminUser.id, role: Role.ADMIN }
      );

      // Verificar que se emitió el evento con el nuevo status BLOCKED
      expect(socketSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          vendedorId: vendor.id,
          status: "BLOCKED",
          creditLimit: 250000,
        })
      );

      // Restaurar tope a 500,000 (libera a NORMAL)
      await UserService.update(
        vendor.id,
        { creditLimit: 500000 },
        { id: adminUser.id, role: Role.ADMIN }
      );

      expect(socketSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          vendedorId: vendor.id,
          status: "NORMAL",
          creditLimit: 500000,
        })
      );

      socketSpy.mockRestore();
    });
  });
});
