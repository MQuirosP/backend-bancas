import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import Redis from "ioredis";
import prisma from "../../src/core/prismaClient";
import { config } from "../../src/config";
import { initRedisClient, getRedisClient, isRedisAvailable } from "../../src/core/redisClient";
import { VendorCreditService } from "../../src/domain/credit/vendorCredit.service";
import { seedTestData, cleanupTestData } from "../../scripts/seed_credit_test";

const runIntegration = process.env.CREDIT_E2E_LOCAL === "true";
const describeOrSkip = runIntegration ? describe : describe.skip;

describeOrSkip("Test de Regresión: Claves en redis.eval sin doble prefijo", () => {
  let seededData: any;
  let rawRedis: Redis;

  beforeAll(async () => {
    config.creditLimit.enabled = true;
    config.redis.enabled = true;
    // Forzar REDIS_PREFIX a "local:" tal como opera en desarrollo/producción
    process.env.REDIS_PREFIX = "local:";

    await initRedisClient();
    const redis = getRedisClient();
    for (let i = 0; i < 30 && (!redis || !isRedisAvailable()); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }

    rawRedis = new Redis({ host: "127.0.0.1", port: 6379 });
    seededData = await seedTestData();
  }, 35000);

  afterAll(async () => {
    if (runIntegration) {
      await cleanupTestData();
    }
    if (rawRedis) {
      rawRedis.disconnect();
    }
  }, 30000);

  it("garantiza que las claves pasadas a redis.eval NO quedan con doble prefijo 'local:local:'", async () => {
    const vendor = seededData.vendorLimited;
    const sorteo = seededData.openSorteos[0];

    // Limpiar claves en Redis directamente
    const existingRaw = await rawRedis.keys(`*${vendor.id}*`);
    if (existingRaw.length > 0) {
      await rawRedis.del(...existingRaw);
    }

    // Ejecutar validateAndReserve que interactúa con Redis Lua (CHECK_AND_RESERVE_LUA)
    const result = await VendorCreditService.validateAndReserve(vendor.id, sorteo.id, 5000);

    // Debe ser OK o BLOCKED según el crédito del vendedor
    expect(["OK", "BLOCKED"]).toContain(result.code);

    // Consultar las llaves crudas directamente en Redis (sin abstracción de ioredis)
    const allRawVendorKeys = await rawRedis.keys(`*${vendor.id}*`);
    expect(allRawVendorKeys.length).toBeGreaterThan(0);

    // CRÍTICO: Ninguna llave debe tener el prefijo duplicado "local:local:"
    const doublePrefixedKeys = allRawVendorKeys.filter((k) => k.startsWith("local:local:"));
    expect(doublePrefixedKeys).toEqual([]);

    // Todas las llaves deben comenzar con un único "local:vendedor:"
    for (const key of allRawVendorKeys) {
      expect(key.startsWith("local:vendedor:")).toBe(true);
    }
  });

  it("garantiza que compensateReservation y updateBaseBalance no generan llaves con doble prefijo", async () => {
    const vendor = seededData.vendorLimited;
    const sorteo = seededData.openSorteos[0];

    await VendorCreditService.compensateReservation(vendor.id, sorteo.id, 1000);
    await VendorCreditService.updateBaseBalance(vendor.id);

    const allRawVendorKeys = await rawRedis.keys(`*${vendor.id}*`);
    const doublePrefixedKeys = allRawVendorKeys.filter((k) => k.startsWith("local:local:"));
    expect(doublePrefixedKeys).toEqual([]);
  });
});
