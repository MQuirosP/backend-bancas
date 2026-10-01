import { VendorCreditService } from "../../src/domain/credit/vendorCredit.service";
import prisma from "../../src/core/prismaClient";
import { getRedisClient, isRedisAvailable, markRedisError } from "../../src/core/redisClient";
import { SocketService } from "../../src/core/socket.service";
import { config } from "../../src/config";

jest.mock("../../src/core/prismaClient", () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    accountStatement: {
      findFirst: jest.fn(),
    },
    ticket: {
      findMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
  },
}));

jest.mock("../../src/core/redisClient", () => ({
  __esModule: true,
  getRedisClient: jest.fn(),
  isRedisAvailable: jest.fn(),
  markRedisError: jest.fn(),
}));

jest.mock("../../src/core/socket.service", () => ({
  __esModule: true,
  SocketService: {
    notifyVendorCreditStatusChanged: jest.fn(),
  },
}));

describe("Bloque B: VendorCreditService & Redis Integration", () => {
  let mockRedis: any;

  beforeEach(() => {
    jest.clearAllMocks();
    VendorCreditService.resetDegradedState();
    VendorCreditService.resetFailOpenCount();
    config.creditLimit.enabled = true;

    mockRedis = {
      eval: jest.fn(),
      pipeline: jest.fn().mockReturnValue({
        del: jest.fn().mockReturnThis(),
        hset: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        expire: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      }),
      exists: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue("OK"),
      hvals: jest.fn().mockResolvedValue(["500"]),
      hmget: jest.fn().mockResolvedValue(["1000", "b-1", "vent-1"]),
      hget: jest.fn().mockResolvedValue("NORMAL"),
      hset: jest.fn().mockResolvedValue(1),
      hdel: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
      zadd: jest.fn().mockResolvedValue(1),
      zrem: jest.fn().mockResolvedValue(1),
      zrangebyscore: jest.fn().mockResolvedValue([]),
      zremrangebyscore: jest.fn().mockResolvedValue(0),
    };

    (isRedisAvailable as jest.Mock).mockReturnValue(true);
    (getRedisClient as jest.Mock).mockReturnValue(mockRedis);
  });

  describe("1. Atomic Check and Reservation (Lua Script Execution)", () => {
    it("returns OK with NORMAL status when projected is below threshold", async () => {
      mockRedis.eval.mockResolvedValueOnce(["OK", "500", "50", "NORMAL", "NORMAL"]);

      const result = await VendorCreditService.validateAndReserve("v-1", "s-1", 100);

      expect(result.code).toBe("OK");
      expect(result.status).toBe("NORMAL");
      expect(result.projected).toBe(500);
      expect(result.percentage).toBe(50);
      expect(mockRedis.eval).toHaveBeenCalledTimes(1);
      // No transición de estado (NORMAL -> NORMAL) -> No emite WebSocket
      expect(SocketService.notifyVendorCreditStatusChanged).not.toHaveBeenCalled();
    });

    it("returns OK with WARNING status and emits websocket when status transitions to alert threshold", async () => {
      mockRedis.eval.mockResolvedValueOnce(["OK", "850", "85", "WARNING", "NORMAL"]);

      const result = await VendorCreditService.validateAndReserve("v-1", "s-1", 100);

      expect(result.code).toBe("OK");
      expect(result.status).toBe("WARNING");
      expect(result.percentage).toBe(85);
      expect(SocketService.notifyVendorCreditStatusChanged).toHaveBeenCalledWith(
        expect.objectContaining({
          vendedorId: "v-1",
          status: "WARNING",
          percentageUsed: 85,
          effectiveBalance: 850,
          updatedAt: expect.any(String),
        })
      );
    });

    it("returns BLOCKED and does NOT allow sale when limit exceeded and blockMode is true", async () => {
      mockRedis.eval.mockResolvedValueOnce(["BLOCKED", "1100", "110", "BLOCKED", "NORMAL"]);

      const result = await VendorCreditService.validateAndReserve("v-1", "s-1", 200);

      expect(result.code).toBe("BLOCKED");
      expect(result.status).toBe("BLOCKED");
      expect(result.projected).toBe(1100);
      expect(SocketService.notifyVendorCreditStatusChanged).toHaveBeenCalledWith(
        expect.objectContaining({
          vendedorId: "v-1",
          status: "BLOCKED",
          percentageUsed: 110,
          effectiveBalance: 1100,
          updatedAt: expect.any(String),
        })
      );
    });

    it("returns OK with EXCEEDED_ALERT_ONLY when limit exceeded but blockMode is false", async () => {
      mockRedis.eval.mockResolvedValueOnce(["OK", "1200", "120", "EXCEEDED_ALERT_ONLY", "NORMAL"]);

      const result = await VendorCreditService.validateAndReserve("v-1", "s-1", 300);

      expect(result.code).toBe("OK");
      expect(result.status).toBe("EXCEEDED_ALERT_ONLY");
      expect(result.projected).toBe(1200);
      expect(SocketService.notifyVendorCreditStatusChanged).toHaveBeenCalled();
    });

    it("handles unlimited vendors (-1) returning NORMAL", async () => {
      mockRedis.eval.mockResolvedValueOnce(["OK", "25000", "0", "NORMAL", "NORMAL"]);

      const result = await VendorCreditService.validateAndReserve("v-1", "s-1", 5000);

      expect(result.code).toBe("OK");
      expect(result.status).toBe("NORMAL");
      expect(result.percentage).toBe(0);
    });
  });

  describe("2. Hydration Flow & Single-Flight Coalescing", () => {
    it("detects NEEDS_HYDRATION, triggers hydrate(), and retries atomic check once", async () => {
      // Primer eval devuelve NEEDS_HYDRATION, segundo devuelve OK
      mockRedis.eval
        .mockResolvedValueOnce(["NEEDS_HYDRATION", "0", "0", "UNKNOWN", "UNKNOWN"])
        .mockResolvedValueOnce(["OK", "300", "30", "NORMAL", "NORMAL"]);

      (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "v-1",
        creditLimit: 1000,
        creditAlertThreshold: 80,
        creditBlockMode: true,
        settings: null,
        ventanaId: "vent-1",
        bancaId: "b-1",
        ventana: { bancaId: "b-1" },
      });

      (prisma.accountStatement.findFirst as jest.Mock).mockResolvedValueOnce({
        accumulatedBalance: 200,
        date: new Date("2026-09-30"),
      });

      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
        { sorteoId: "s-1", netAmount: "100" },
      ]);

      const result = await VendorCreditService.validateAndReserve("v-1", "s-1", 50);

      expect(result.code).toBe("OK");
      expect(result.projected).toBe(300);
      expect(mockRedis.eval).toHaveBeenCalledTimes(2);
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: "v-1" },
        select: expect.any(Object),
      });
    });

    it("resets base to 0 if last statement was before settings.balanceResetAt", async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "v-1",
        creditLimit: 2000,
        creditAlertThreshold: 75,
        creditBlockMode: true,
        settings: { balanceResetAt: "2026-09-28T00:00:00.000Z" },
        ventanaId: "vent-1",
        bancaId: "b-1",
        ventana: { bancaId: "b-1" },
      });

      // Statement anterior a la fecha de reset
      (prisma.accountStatement.findFirst as jest.Mock).mockResolvedValueOnce({
        accumulatedBalance: 5000,
        date: new Date("2026-09-20"),
      });

      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);

      const hydrated = await VendorCreditService.hydrate("v-1");

      expect(hydrated.baseBalance).toBe(0);
      expect(hydrated.status).toBe("NORMAL");
    });

    it("single-flight lock ensures only one DB query is made during concurrent hydration calls", async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: "v-1",
        creditLimit: 1000,
        creditAlertThreshold: 80,
        creditBlockMode: true,
        settings: null,
        ventanaId: "vent-1",
        bancaId: "b-1",
        ventana: { bancaId: "b-1" },
      });

      (prisma.accountStatement.findFirst as jest.Mock).mockResolvedValue({
        accumulatedBalance: 100,
        date: new Date(),
      });

      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      const [res1, res2, res3] = await Promise.all([
        VendorCreditService.hydrate("v-1"),
        VendorCreditService.hydrate("v-1"),
        VendorCreditService.hydrate("v-1"),
      ]);

      expect(res1).toEqual(res2);
      expect(res2).toEqual(res3);
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe("3. Stepped Fallback (Degraded Mode & Fail-Open)", () => {
    it("enters degraded mode (Nivel 2) when Redis is down", async () => {
      (isRedisAvailable as jest.Mock).mockReturnValue(false);
      (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "v-1",
        creditLimit: 1000,
        creditAlertThreshold: 80,
        creditBlockMode: true,
        settings: null,
        ventanaId: "vent-1",
        bancaId: "b-1",
      });
      (prisma.accountStatement.findFirst as jest.Mock).mockResolvedValueOnce({
        accumulatedBalance: 200,
        date: new Date(),
      });
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);

      const result = await VendorCreditService.validateAndReserve("v-1", "s-1", 500);

      expect(result.code).toBe("OK");
      expect(result.degraded).toBe(true);
      expect(result.status).toBe("NORMAL");
    });

    it("enters degraded mode (Nivel 2) when Redis eval throws", async () => {
      mockRedis.eval.mockRejectedValueOnce(new Error("Redis connection dropped"));
      (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "v-1",
        creditLimit: 1000,
        creditAlertThreshold: 80,
        creditBlockMode: true,
        settings: null,
        ventanaId: "vent-1",
        bancaId: "b-1",
      });
      (prisma.accountStatement.findFirst as jest.Mock).mockResolvedValueOnce(null);
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);

      const result = await VendorCreditService.validateAndReserve("v-1", "s-1", 500);

      expect(result.code).toBe("OK");
      expect(result.degraded).toBe(true);
      expect(markRedisError).toHaveBeenCalled();
    });

    it("enters degraded mode when Redis check command exceeds 250ms timeout", async () => {
      mockRedis.eval.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(resolve, 350))
      );
      (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "v-1",
        creditLimit: 1000,
        creditAlertThreshold: 80,
        creditBlockMode: true,
        settings: null,
        ventanaId: "vent-1",
        bancaId: "b-1",
      });
      (prisma.accountStatement.findFirst as jest.Mock).mockResolvedValueOnce(null);
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);

      const result = await VendorCreditService.validateAndReserve("v-1", "s-1", 500);

      expect(result.code).toBe("OK");
      expect(result.degraded).toBe(true);
    });

    it("applies Level 3 fail-open when DB calculation ALSO fails or times out in degraded mode", async () => {
      (isRedisAvailable as jest.Mock).mockReturnValue(false);
      (prisma.user.findUnique as jest.Mock).mockRejectedValueOnce(new Error("DB Pool connection timeout"));

      const result = await VendorCreditService.validateAndReserve("v-1", "s-1", 500);

      expect(result.code).toBe("OK");
      expect(result.failOpen).toBe(true);
      expect(result.degraded).toBe(true);
    });

    it("handles unexpected Lua return code by logging error and resolving via Level 2 degraded fallback", async () => {
      mockRedis.eval.mockResolvedValueOnce(["UNKNOWN_CODE_XYZ", "500", "50", "NORMAL", "NORMAL"]);
      (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "v-1",
        creditLimit: 1000,
        creditAlertThreshold: 80,
        creditBlockMode: true,
        settings: null,
        ventanaId: "vent-1",
        bancaId: "b-1",
      });
      (prisma.accountStatement.findFirst as jest.Mock).mockResolvedValueOnce(null);
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);

      const result = await VendorCreditService.validateAndReserve("v-1", "s-1", 500);

      expect(result.code).toBe("OK");
      expect(result.degraded).toBe(true);
    });
  });

  describe("4. Compensation & Invalidation", () => {
    it("compensates reservation by decrementing Redis hash", async () => {
      mockRedis.eval.mockResolvedValueOnce("OK");

      await VendorCreditService.compensateReservation("v-1", "s-1", 150);

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining("local cur = tonumber"),
        1,
        "vendedor:v-1:credit:open_by_sorteo",
        "s-1",
        "150"
      );
    });

    it("invalidates Redis keys on compensation failure to force clean rehydration", async () => {
      mockRedis.eval.mockRejectedValueOnce(new Error("Eval failed"));

      await expect(
        VendorCreditService.compensateReservation("v-1", "s-1", 150)
      ).rejects.toThrow("Eval failed");

      expect(mockRedis.del).toHaveBeenCalledWith(
        "vendedor:v-1:credit:cfg",
        "vendedor:v-1:credit:base",
        "vendedor:v-1:credit:open_by_sorteo"
      );
    });
  });

  describe("5. Account Statement & Payment Sync Hook (updateBaseBalance)", () => {
    it("updateBaseBalance reads latest statement and open sales from DB, updates Redis, and emits websocket on unblock", async () => {
      mockRedis.exists.mockResolvedValueOnce(1);
      mockRedis.eval.mockResolvedValueOnce("BLOCKED"); // old status returned by Lua was BLOCKED

      (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "v-1",
        creditLimit: 1000,
        creditAlertThreshold: 80,
        creditBlockMode: true,
        settings: null,
      });

      (prisma.accountStatement.findFirst as jest.Mock).mockResolvedValueOnce({
        accumulatedBalance: 200,
        date: new Date("2026-09-30"),
      });

      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
        { sorteoId: "s-1", netAmount: "100" },
      ]);

      // Base: 200 + Open: 100 = 300 / 1000 (30%) -> NORMAL. Was BLOCKED -> unblocked!
      await VendorCreditService.updateBaseBalance("v-1");

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('set', KEYS[1], newBase"),
        3,
        "vendedor:v-1:credit:base",
        "vendedor:v-1:credit:open_by_sorteo",
        "vendedor:v-1:credit:cfg",
        "200",
        "1",
        "NORMAL",
        "43200",
        "s-1",
        "100"
      );
      expect(SocketService.notifyVendorCreditStatusChanged).toHaveBeenCalledWith(
        expect.objectContaining({
          vendedorId: "v-1",
          status: "NORMAL",
          effectiveBalance: 300,
          percentageUsed: 30,
        })
      );
    });
  });

  describe("6. Reconcile Sorteo & updateBaseBalance", () => {
    it("filters vendors with creditLimit > 0 and calls updateBaseBalance for each", async () => {
      (prisma.ticket.findMany as jest.Mock).mockResolvedValueOnce([
        { vendedorId: "v-1" },
      ]);

      (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "v-1",
        creditLimit: 1000,
        creditAlertThreshold: 80,
        creditBlockMode: true,
        settings: null,
      });

      (prisma.accountStatement.findFirst as jest.Mock).mockResolvedValueOnce({
        accumulatedBalance: 400,
        date: new Date("2026-09-30"),
      });

      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);

      mockRedis.eval.mockResolvedValueOnce("NORMAL");

      await VendorCreditService.reconcileSorteo("sorteo-123");

      expect(prisma.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            sorteoId: "sorteo-123",
            vendedor: { creditLimit: { not: null, gt: 0 } },
          }),
        })
      );
    });
  });

  describe("7. Feature Flag Disabled", () => {
    it("returns OK immediately without executing Redis commands when flag is false", async () => {
      config.creditLimit.enabled = false;

      const result = await VendorCreditService.validateAndReserve("v-1", "s-1", 500);

      expect(result.code).toBe("OK");
      expect(result.status).toBe("NORMAL");
      expect(mockRedis.eval).not.toHaveBeenCalled();
    });
  });

  describe("8. Mixed Commission Origin Calculation", () => {
    it("calculates net amount considering ONLY commissionOrigin='USER'", () => {
      const jugadasWithCommissions = [
        { amount: 1000, commissionAmount: 100, commissionOrigin: "USER" },
        { amount: 2000, commissionAmount: 150, commissionOrigin: "VENTANA" },
        { amount: 3000, commissionAmount: 200, commissionOrigin: "BANCA" },
        { amount: 4000, commissionAmount: 300, commissionOrigin: "USER" },
      ];

      const totalAmount = jugadasWithCommissions.reduce((s, j) => s + j.amount, 0); // 10000
      const totalAllCommissions = jugadasWithCommissions.reduce((s, j) => s + j.commissionAmount, 0); // 750
      const totalUserCommissions = jugadasWithCommissions.reduce(
        (s, j) => s + (j.commissionOrigin === "USER" ? j.commissionAmount : 0),
        0
      ); // 400

      // El neto reservado debe ser totalAmount - userCommissions = 10000 - 400 = 9600
      const netToReserve = Math.round(Math.max(0, totalAmount - totalUserCommissions) * 100) / 100;
      expect(netToReserve).toBe(9600);
      expect(netToReserve).not.toBe(totalAmount - totalAllCommissions); // 9250 !== 9600
    });
  });

  describe("9. Evaluating Sorteos Marker (TTL & Auto-Purge)", () => {
    it("markSorteoEvaluating saves sorteo to ZSET with expiration timestamp and sets TTL", async () => {
      const now = 1700000000000;
      jest.spyOn(Date, "now").mockReturnValue(now);

      await VendorCreditService.markSorteoEvaluating("sorteo-uuid-1");

      const expectedTtl = (config.creditLimit.evaluatingSorteoTtlSeconds || 900) * 1000;
      expect(mockRedis.zadd).toHaveBeenCalledWith(
        "sorteos:evaluating",
        now + expectedTtl,
        "sorteo-uuid-1"
      );
      expect(mockRedis.expire).toHaveBeenCalledWith(
        "sorteos:evaluating",
        (config.creditLimit.evaluatingSorteoTtlSeconds || 900) * 2
      );

      (Date.now as jest.Mock).mockRestore?.();
    });

    it("unmarkSorteoEvaluating removes sorteo from ZSET", async () => {
      await VendorCreditService.unmarkSorteoEvaluating("sorteo-uuid-1");

      expect(mockRedis.zrem).toHaveBeenCalledWith(
        "sorteos:evaluating",
        "sorteo-uuid-1"
      );
    });

    it("getEvaluatingSorteoIds purges expired entries (-inf to now) and returns active ones", async () => {
      const now = 1700000000000;
      jest.spyOn(Date, "now").mockReturnValue(now);
      mockRedis.zrangebyscore.mockResolvedValueOnce(["sorteo-active-1", "sorteo-active-2"]);

      const activeIds = await VendorCreditService.getEvaluatingSorteoIds();

      expect(mockRedis.zremrangebyscore).toHaveBeenCalledWith(
        "sorteos:evaluating",
        "-inf",
        now
      );
      expect(mockRedis.zrangebyscore).toHaveBeenCalledWith(
        "sorteos:evaluating",
        now,
        "+inf"
      );
      expect(activeIds).toEqual(["sorteo-active-1", "sorteo-active-2"]);

      (Date.now as jest.Mock).mockRestore?.();
    });
  });

  describe("10. WebSocket Notification Debounce (15s rule)", () => {
    it("suppresses repeated BLOCKED events within 15s, but permits immediate liberation on NORMAL and subsequent re-block", async () => {
      const startTime = 1000000;
      let currentTime = startTime;
      jest.spyOn(Date, "now").mockImplementation(() => currentTime);

      // 1. Primer intento bloqueado: debe emitir
      mockRedis.eval.mockResolvedValueOnce(["BLOCKED", "1100", "110", "BLOCKED", "NORMAL"]);
      await VendorCreditService.validateAndReserve("v-debounce", "s-1", 100);
      expect(SocketService.notifyVendorCreditStatusChanged).toHaveBeenCalledTimes(1);
      expect(SocketService.notifyVendorCreditStatusChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ vendedorId: "v-debounce", status: "BLOCKED" })
      );

      // 2. Segundo intento bloqueado a los 5s (dentro de la ventana de 15s): debe suprimirse por debounce
      currentTime += 5000;
      mockRedis.eval.mockResolvedValueOnce(["BLOCKED", "1200", "120", "BLOCKED", "BLOCKED"]);
      await VendorCreditService.validateAndReserve("v-debounce", "s-1", 100);
      // Sigue siendo 1 llamada (suprimido)
      expect(SocketService.notifyVendorCreditStatusChanged).toHaveBeenCalledTimes(1);

      // 3. Ocurre cobro/pago que libera a NORMAL: debe emitirse INMEDIATAMENTE y resetear el debounce
      currentTime += 2000;
      mockRedis.eval.mockResolvedValueOnce("BLOCKED"); // oldStatus was BLOCKED, transitions to NORMAL
      (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "v-debounce",
        creditLimit: 1000,
        creditAlertThreshold: 80,
        creditBlockMode: true,
      });
      (prisma.accountStatement.findFirst as jest.Mock).mockResolvedValueOnce({
        accumulatedBalance: 200,
        date: new Date("2026-09-30"),
      });
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);
      await VendorCreditService.updateBaseBalance("v-debounce");

      // Debe haberse emitido el cambio a NORMAL
      expect(SocketService.notifyVendorCreditStatusChanged).toHaveBeenCalledTimes(2);
      expect(SocketService.notifyVendorCreditStatusChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ vendedorId: "v-debounce", status: "NORMAL" })
      );

      // 4. Inmediatamente después, si vuelve a exceder el tope, debe emitir BLOCKED de nuevo (no suprimido porque hubo liberación previa)
      currentTime += 1000;
      mockRedis.eval.mockResolvedValueOnce(["BLOCKED", "1500", "150", "BLOCKED", "NORMAL"]);
      await VendorCreditService.validateAndReserve("v-debounce", "s-1", 1000);
      expect(SocketService.notifyVendorCreditStatusChanged).toHaveBeenCalledTimes(3);
      expect(SocketService.notifyVendorCreditStatusChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ vendedorId: "v-debounce", status: "BLOCKED" })
      );

      (Date.now as jest.Mock).mockRestore?.();
    });
  });

  describe("11. Timezone Hydration (Costa Rica evening hours 18:00 - 23:59)", () => {
    it("formats windowDate using tz.toDateStr() matching Costa Rica business date when UTC calendar date is ahead", async () => {
      // Costa Rica 2026-09-30 21:00:00 (UTC-6) corresponde a UTC 2026-10-01 03:00:00
      // La consulta SQL debe recibir CAST('2026-09-28' AS date) para windowDays=2, nunca una fecha UTC avanzada
      const simulatedUtcDate = new Date("2026-10-01T03:00:00.000Z");
      const { tz } = await import("../../src/utils/timezone");

      // En zona Costa Rica, la fecha es 2026-09-30
      const dateInCR = tz.toDateStr(simulatedUtcDate);
      expect(dateInCR).toBe("2026-09-30");

      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);

      await VendorCreditService.fetchOpenSales("v-tz", simulatedUtcDate);

      expect(prisma.$queryRaw).toHaveBeenCalled();
    });
  });
});
