/// <reference types="jest" />
jest.mock("uuid", () => ({
  v4: () => "req-test-uuid-" + Math.random().toString(36).substring(7),
}));

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

process.env.REDIS_PREFIX = "local:";
process.env.CREDIT_LIMIT_ENABLED = "true";

import request from "supertest";
import jwt from "jsonwebtoken";
import prisma from "../../src/core/prismaClient";
import app from "../../src/server/app";
import { config } from "../../src/config";
import * as redisClientModule from "../../src/core/redisClient";
import { initRedisClient, getRedisClient, isRedisAvailable } from "../../src/core/redisClient";
import { VendorCreditService } from "../../src/domain/credit/vendorCredit.service";
import { SocketService } from "../../src/core/socket.service";
import { Role, BetType } from "../../src/generated/prisma/client";
import { tz } from "../../src/utils/timezone";
import { seedTestData, cleanupTestData, TEST_MARKER } from "../../scripts/seed_credit_test";

const runIntegration = process.env.CREDIT_E2E_LOCAL === "true";
const describeOrSkip = runIntegration ? describe : describe.skip;

function createToken(userId: string, role: Role, ventanaId?: string | null, bancaId?: string | null) {
  return jwt.sign(
    {
      sub: userId,
      role,
      ventanaId: ventanaId ?? null,
      bancaId: bancaId ?? null,
    },
    config.jwtAccessSecret,
    { expiresIn: "1h" }
  );
}

describeOrSkip("HTTP E2E: Control de Crédito y Fallback Escalonado (Supertest)", () => {
  let seededData: any;
  let redis: any;
  let vendor: any;
  let adminUser: any;
  let ventanaUser: any;
  let multiplier: any;
  let vendorToken: string;
  let adminToken: string;
  let ventanaToken: string;
  let socketSpy: jest.SpyInstance;

  beforeAll(async () => {
    config.creditLimit.enabled = true;
    config.redis.enabled = true;
    config.creditLimit.degradedTtlMs = 3000;
    config.creditLimit.degradedDbTimeoutMs = 1000;

    await initRedisClient();
    redis = getRedisClient();
    for (let i = 0; i < 30 && (!redis || !isRedisAvailable()); i++) {
      await new Promise((r) => setTimeout(r, 100));
      redis = getRedisClient();
    }

    seededData = await seedTestData();
    vendor = seededData.vendorLimited;

    // Configurar vendedor para el caso de prueba: tope 100,000, umbral 80%, modo bloqueo, base 0
    await prisma.user.update({
      where: { id: vendor.id },
      data: {
        creditLimit: 100000,
        creditAlertThreshold: 80,
        creditBlockMode: true,
        commissionPolicyJson: { version: 1, defaultPercent: 0, rules: [] }, // 0% para montos netos exactos
      },
    });

    // Poner balance base a 0 en AccountStatement
    const todayDate = seededData.todayDateUTC;
    await prisma.accountStatement.updateMany({
      where: { vendedorId: vendor.id, date: todayDate },
      data: { accumulatedBalance: 0, balance: 0, totalSales: 0 },
    });

    adminUser = await prisma.user.findFirst({ where: { role: Role.ADMIN, isActive: true } });
    if (!adminUser) {
      adminUser = await prisma.user.create({
        data: {
          name: `${TEST_MARKER}ADMIN`,
          username: "test-admin-credit-e2e",
          password: "$2b$10$epRswZ5V0d8pB2E7.W5aUeN7tqB3wH6mY9gL1f2s3k4l5m6n7o8p9",
          role: Role.ADMIN,
          isActive: true,
        },
      });
    }

    ventanaUser = await prisma.user.findFirst({
      where: { role: Role.VENTANA, ventanaId: seededData.ventana.id, isActive: true },
    });
    if (!ventanaUser) {
      ventanaUser = await prisma.user.create({
        data: {
          name: `${TEST_MARKER}VENTANA-USER`,
          username: "test-ventana-credit-e2e",
          password: "$2b$10$epRswZ5V0d8pB2E7.W5aUeN7tqB3wH6mY9gL1f2s3k4l5m6n7o8p9",
          role: Role.VENTANA,
          ventanaId: seededData.ventana.id,
          isActive: true,
        },
      });
    }

    multiplier = await prisma.loteriaMultiplier.findFirst({
      where: { loteriaId: seededData.loterias[0].id, isActive: true },
    });

    // Asegurar que las loterías de prueba permitan apuestas grandes para no limitar el monto
    for (const lot of seededData.loterias) {
      await prisma.loteria.update({
        where: { id: lot.id },
        data: { rulesJson: { minBet: 10, maxBet: 2000000 } },
      });
    }

    vendorToken = createToken(vendor.id, Role.VENDEDOR, seededData.ventana.id, seededData.banca.id);
    adminToken = createToken(adminUser.id, Role.ADMIN, null, seededData.banca.id);
    ventanaToken = createToken(ventanaUser.id, Role.VENTANA, seededData.ventana.id, seededData.banca.id);

    // Invalidad claves en Redis para forzar hidratación limpia
    await VendorCreditService.invalidateKeys(vendor.id);
    VendorCreditService.resetDegradedState();

    socketSpy = jest.spyOn(SocketService, "notifyVendorCreditStatusChanged");
  }, 40000);

  afterAll(async () => {
    if (socketSpy) socketSpy.mockRestore();
    if (runIntegration) {
      await cleanupTestData();
    }
  }, 30000);

  it("1. Tope 100000 y modo bloqueo: ticket de 196000 es rechazado con 409 CREDIT_LIMIT_EXCEEDED", async () => {
    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${vendorToken}`)
      .send({
        sorteoId: seededData.openSorteos[0].id,
        loteriaId: seededData.loterias[0].id,
        ventanaId: seededData.ventana.id,
        clienteNombre: "Cliente Test 196k",
        jugadas: [
          { number: "10", amount: 196000, type: BetType.NUMERO, multiplierId: multiplier.id },
        ],
      });

    expect(res.status).toBe(409);
    expect(res.body.meta).toBe("CREDIT_LIMIT_EXCEEDED");
    expect(res.body.message).toContain("límite de caja");
  });

  it("2. Ticket de 90000 pasa con 200, warning CREDIT_LIMIT_WARNING y creditInfo (90%)", async () => {
    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${vendorToken}`)
      .send({
        sorteoId: seededData.openSorteos[0].id,
        loteriaId: seededData.loterias[0].id,
        ventanaId: seededData.ventana.id,
        clienteNombre: "Cliente Test 90k",
        jugadas: [
          { number: "20", amount: 90000, type: BetType.NUMERO, multiplierId: multiplier.id },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.creditInfo).toBeDefined();
    expect(res.body.data.creditInfo.limit).toBe(100000);
    expect(res.body.data.creditInfo.effectiveBalance).toBe(90000);
    expect(res.body.data.creditInfo.percentageUsed).toBe(90);
    expect(res.body.data.creditInfo.status).toBe("WARNING");

    // Verificar warning incluido en la respuesta
    const warnings = res.body.data.warnings || [];
    const creditWarning = warnings.find((w: any) => w.code === "CREDIT_LIMIT_WARNING");
    expect(creditWarning).toBeDefined();
    expect(creditWarning.status).toBe("WARNING");

    // Verificar emisión de evento por socket ante cambio a WARNING
    expect(socketSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        vendedorId: vendor.id,
        status: "WARNING",
      })
    );
  });

  it("3. Ticket subsiguiente de 20000 excede tope (90k + 20k = 110k > 100k) => 409 CREDIT_LIMIT_EXCEEDED", async () => {
    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${vendorToken}`)
      .send({
        sorteoId: seededData.openSorteos[0].id,
        loteriaId: seededData.loterias[0].id,
        ventanaId: seededData.ventana.id,
        clienteNombre: "Cliente Test 20k",
        jugadas: [
          { number: "30", amount: 20000, type: BetType.NUMERO, multiplierId: multiplier.id },
        ],
      });

    expect(res.status).toBe(409);
    expect(res.body.meta).toBe("CREDIT_LIMIT_EXCEEDED");

    // Verificar emisión de evento por socket ante transición a BLOCKED
    expect(socketSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        vendedorId: vendor.id,
        status: "BLOCKED",
      })
    );
  });

  it("3b. El vendedor recibe vendor:credit_status_changed ante la liberación (NORMAL) después de un cobro", async () => {
    socketSpy.mockClear();

    // Registrar un cobro/pago para reducir el saldo del vendedor y liberarlo
    const payRes = await request(app)
      .post("/api/v1/accounts/payment")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        date: tz.toDateStr(),
        vendedorId: vendor.id,
        amount: 80000,
        type: "collection",
        method: "cash",
        notes: "Cobro para liberar crédito",
      });

    expect(payRes.status).toBe(201);
    expect(payRes.body.success).toBe(true);

    // Verificar que el evento de socket se emitió con status: "NORMAL"
    expect(socketSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        vendedorId: vendor.id,
        status: "NORMAL",
      })
    );
  });

  it("4. Modo alerta (creditBlockMode=false): ticket que supera tope responde 200 con warnings", async () => {
    // Cambiar a modo alerta
    await prisma.user.update({
      where: { id: vendor.id },
      data: { creditBlockMode: false },
    });
    await VendorCreditService.invalidateKeys(vendor.id);

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${vendorToken}`)
      .send({
        sorteoId: seededData.openSorteos[0].id,
        loteriaId: seededData.loterias[0].id,
        ventanaId: seededData.ventana.id,
        clienteNombre: "Cliente Modo Alerta",
        jugadas: [
          { number: "40", amount: 150000, type: BetType.NUMERO, multiplierId: multiplier.id },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const warnings = res.body.data.warnings || [];
    const warning = warnings.find((w: any) => w.code === "CREDIT_LIMIT_WARNING");
    expect(warning).toBeDefined();
    expect(warning.status).toBe("EXCEEDED_ALERT_ONLY");
  });

  it("5. Ticket creado por VENTANA para ese vendedor respeta el tope del vendedor efectivo", async () => {
    // Volver a modo bloqueo
    await prisma.user.update({
      where: { id: vendor.id },
      data: { creditBlockMode: true },
    });
    await VendorCreditService.invalidateKeys(vendor.id);

    // Intentar crear ticket de 50000 a nombre del vendedor desde la cuenta VENTANA (acumulado ya > 100k)
    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${ventanaToken}`)
      .send({
        sorteoId: seededData.openSorteos[0].id,
        loteriaId: seededData.loterias[0].id,
        ventanaId: seededData.ventana.id,
        vendedorId: vendor.id,
        clienteNombre: "Cliente por Ventana",
        jugadas: [
          { number: "50", amount: 50000, type: BetType.NUMERO, multiplierId: multiplier.id },
        ],
      });

    expect(res.status).toBe(409);
    expect(res.body.meta).toBe("CREDIT_LIMIT_EXCEEDED");
  });

  it("6. Cambio dinámico de tope vía PATCH /users/:id se aplica en el siguiente ticket sin reiniciar", async () => {
    // Admin eleva el tope a 300,000 vía PATCH /users/:id
    const patchRes = await request(app)
      .patch(`/api/v1/users/${vendor.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ creditLimit: 300000 });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.creditLimit).toBe(300000);

    // Ahora el ticket de 20,000 que antes fallaba debe pasar
    const ticketRes = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${vendorToken}`)
      .send({
        sorteoId: seededData.openSorteos[0].id,
        loteriaId: seededData.loterias[0].id,
        ventanaId: seededData.ventana.id,
        clienteNombre: "Cliente Post Ampliacion",
        jugadas: [
          { number: "60", amount: 20000, type: BetType.NUMERO, multiplierId: multiplier.id },
        ],
      });

    expect(ticketRes.status).toBe(200);
    expect(ticketRes.body.data.creditInfo.limit).toBe(300000);
  });

  describe("Fallback Escalonado (Redis no disponible / cliente terminal)", () => {
    let redisSpy: any;

    beforeAll(() => {
      redisSpy = jest.spyOn(redisClientModule, "isRedisAvailable").mockReturnValue(false);
      VendorCreditService.enterDegradedMode("Simulación de prueba: Redis desconectado");
    });

    afterAll(async () => {
      if (redisSpy) redisSpy.mockRestore();
      await VendorCreditService.exitDegradedMode();
    });

    it("8. Con Redis desconectado: sigue bloqueando por Fallback Nivel 2 y retorna degraded: true", async () => {
      // Bajar tope a 50,000 (el saldo ya supera 100,000)
      await prisma.user.update({
        where: { id: vendor.id },
        data: { creditLimit: 50000, creditBlockMode: true },
      });
      VendorCreditService.resetDegradedState();
      VendorCreditService.enterDegradedMode("Test degraded block");

      const res = await request(app)
        .post("/api/v1/tickets")
        .set("Authorization", `Bearer ${vendorToken}`)
        .send({
          sorteoId: seededData.openSorteos[0].id,
          loteriaId: seededData.loterias[0].id,
          ventanaId: seededData.ventana.id,
          clienteNombre: "Cliente Degradado Bloqueado",
          jugadas: [
            { number: "70", amount: 10000, type: BetType.NUMERO, multiplierId: multiplier.id },
          ],
        });

      // El fallback en PostgreSQL debe bloquear
      expect(res.status).toBe(409);
      expect(res.body.meta).toBe("CREDIT_LIMIT_EXCEEDED");
    });

    it("9. Con Redis desconectado: dos tickets consecutivos dentro del TTL acumulan deltas locales y marcan degraded: true", async () => {
      // Elevar tope a 500,000 para permitir compras
      await prisma.user.update({
        where: { id: vendor.id },
        data: { creditLimit: 500000, creditBlockMode: true },
      });
      VendorCreditService.resetDegradedState();
      VendorCreditService.enterDegradedMode("Test dos tickets consecutivos");

      const t1 = await request(app)
        .post("/api/v1/tickets")
        .set("Authorization", `Bearer ${vendorToken}`)
        .send({
          sorteoId: seededData.openSorteos[0].id,
          loteriaId: seededData.loterias[0].id,
          ventanaId: seededData.ventana.id,
          clienteNombre: "Degradado Consecutivo 1",
          jugadas: [
            { number: "81", amount: 15000, type: BetType.NUMERO, multiplierId: multiplier.id },
          ],
        });

      expect(t1.status).toBe(200);
      expect(t1.body.data.creditInfo.degraded).toBe(true);
      const bal1 = t1.body.data.creditInfo.effectiveBalance;

      // Segundo ticket inmediato dentro de la ventana de TTL (3s)
      const t2 = await request(app)
        .post("/api/v1/tickets")
        .set("Authorization", `Bearer ${vendorToken}`)
        .send({
          sorteoId: seededData.openSorteos[0].id,
          loteriaId: seededData.loterias[0].id,
          ventanaId: seededData.ventana.id,
          clienteNombre: "Degradado Consecutivo 2",
          jugadas: [
            { number: "82", amount: 10000, type: BetType.NUMERO, multiplierId: multiplier.id },
          ],
        });

      expect(t2.status).toBe(200);
      expect(t2.body.data.creditInfo.degraded).toBe(true);
      const bal2 = t2.body.data.creditInfo.effectiveBalance;

      // El segundo saldo debe haber acumulado exactamente los 10,000 adicionales del delta en memoria
      expect(bal2).toBe(bal1 + 10000);
    });

    it("10. Fallo simultáneo de BD y Redis: aplica Nivel 3 Fail-Open sin bloquear al vendedor", async () => {
      // Simular fallo de BD en la consulta de crédito degradada
      const dbSpy = jest.spyOn(prisma.accountStatement, "findFirst").mockRejectedValueOnce(new Error("DB Timeout Simulado"));
      const failOpenBefore = VendorCreditService.getFailOpenCount();

      // Forzar expiración de caché para obligar consulta a BD
      VendorCreditService.resetDegradedState();
      VendorCreditService.enterDegradedMode("Test fallo simultaneo");

      const res = await request(app)
        .post("/api/v1/tickets")
        .set("Authorization", `Bearer ${vendorToken}`)
        .send({
          sorteoId: seededData.openSorteos[0].id,
          loteriaId: seededData.loterias[0].id,
          ventanaId: seededData.ventana.id,
          clienteNombre: "Cliente Fail Open",
          jugadas: [
            { number: "90", amount: 5000, type: BetType.NUMERO, multiplierId: multiplier.id },
          ],
        });

      // Debe permitir la venta bajo fail-open
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(VendorCreditService.getFailOpenCount()).toBeGreaterThan(failOpenBefore);

      dbSpy.mockRestore();
    });

    it("11. Recuperación: al volver Redis, se invalidan claves y se rehidrata sin subconteo", async () => {
      if (redisSpy) redisSpy.mockRestore();
      // Salir del modo degradado para simular recuperación
      await VendorCreditService.exitDegradedMode();
      expect(VendorCreditService.isDegraded()).toBe(false);

      // Siguiente venta con Redis restaurado
      const res = await request(app)
        .post("/api/v1/tickets")
        .set("Authorization", `Bearer ${vendorToken}`)
        .send({
          sorteoId: seededData.openSorteos[0].id,
          loteriaId: seededData.loterias[0].id,
          ventanaId: seededData.ventana.id,
          clienteNombre: "Cliente Post Recuperacion",
          jugadas: [
            { number: "91", amount: 5000, type: BetType.NUMERO, multiplierId: multiplier.id },
          ],
        });

      expect(res.status).toBe(200);
      // Con Redis arriba, degraded ya no debe ser true
      expect(res.body.data.creditInfo.degraded).toBeUndefined();
      expect(res.body.data.creditInfo.effectiveBalance).toBeGreaterThan(0);
    });
  });
});
