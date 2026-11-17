/// <reference types="jest" />

jest.mock("uuid", () => ({
  v4: () => "mock-uuid-1234",
}));

import { TicketConcurrencyManager } from "../../src/domain/ticket/pipeline/TicketConcurrencyManager";
import * as redisClient from "../../src/core/redisClient";
import * as restrictionHelper from "../../src/repositories/helpers/ticket-restriction.helper";

jest.mock("../../src/core/redisClient", () => ({
  isRedisSalesAvailable: jest.fn(() => true),
}));

jest.mock("../../src/repositories/helpers/ticket-restriction.helper", () => ({
  acquireLock: jest.fn(async () => true),
  releaseLock: jest.fn(async () => true),
  acquireMultiLock: jest.fn(async () => true),
  releaseMultiLock: jest.fn(async () => true),
}));

jest.mock("../../src/domain/ticket/pipeline/TicketPrefetchService", () => ({
  TicketPrefetchService: {
    fetchVentanaWithBanca: jest.fn(async () => ({ id: "v-1", bancaId: "b-1" })),
  },
}));

describe("TicketConcurrencyManager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (redisClient.isRedisSalesAvailable as jest.Mock).mockReturnValue(true);
    (restrictionHelper.acquireLock as jest.Mock).mockResolvedValue(true);
    (restrictionHelper.acquireMultiLock as jest.Mock).mockResolvedValue(true);
  });

  it("usa locks granulares por número y banca cuando existe regla compartida de banca", async () => {
    const handle = await TicketConcurrencyManager.acquire(
      "sorteo-1",
      "ventana-1",
      "user-1",
      {
        preFetched: {
          ventana: { id: "ventana-1", bancaId: "banca-cen" },
          rules: [
            {
              isActive: true,
              bancaId: "banca-cen",
              ventanaId: null,
              userId: null,
              appliesToVendedor: false,
              maxAmount: 80000,
              maxTotal: 80000,
              baseAmount: null,
              salesPercentage: null,
            },
          ],
        },
      },
      ["46", "17", "17"]
    );

    expect(restrictionHelper.acquireMultiLock).toHaveBeenCalledWith(
      [
        "lock:ticket-num:sorteo-1:banca:banca-cen:17",
        "lock:ticket-num:sorteo-1:banca:banca-cen:46",
      ],
      expect.any(String),
      10
    );
    expect(handle?.lockKeys).toEqual([
      "lock:ticket-num:sorteo-1:banca:banca-cen:17",
      "lock:ticket-num:sorteo-1:banca:banca-cen:46",
    ]);

    await TicketConcurrencyManager.release(handle);
    expect(restrictionHelper.releaseMultiLock).toHaveBeenCalledWith(
      handle?.lockKeys,
      handle?.lockValue
    );
  });

  it("usa locks granulares por número y ventana cuando existe regla compartida de ventana", async () => {
    const handle = await TicketConcurrencyManager.acquire(
      "sorteo-1",
      "ventana-1",
      "user-1",
      {
        preFetched: {
          ventana: { id: "ventana-1", bancaId: "banca-cen" },
          rules: [
            {
              isActive: true,
              bancaId: "banca-cen",
              ventanaId: "ventana-1",
              userId: null,
              appliesToVendedor: false,
              maxAmount: 50000,
              maxTotal: null,
              baseAmount: null,
              salesPercentage: null,
            },
          ],
        },
      },
      ["05"]
    );

    expect(restrictionHelper.acquireLock).toHaveBeenCalledWith(
      "lock:ticket-num:sorteo-1:ventana:ventana-1:05",
      expect.any(String),
      10
    );
    expect(handle?.lockKeys).toEqual(["lock:ticket-num:sorteo-1:ventana:ventana-1:05"]);
  });

  it("usa lock por vendedor cuando la regla aplica por vendedor", async () => {
    const handle = await TicketConcurrencyManager.acquire(
      "sorteo-1",
      "ventana-1",
      "user-1",
      {
        preFetched: {
          ventana: { id: "ventana-1", bancaId: "banca-cen" },
          rules: [
            {
              isActive: true,
              bancaId: "banca-cen",
              ventanaId: null,
              userId: null,
              appliesToVendedor: true,
              maxAmount: 80000,
              maxTotal: 80000,
              baseAmount: null,
              salesPercentage: null,
            },
          ],
        },
      },
      ["17", "46"]
    );

    expect(restrictionHelper.acquireLock).toHaveBeenCalledWith(
      "lock:ticket-create:sorteo:sorteo-1:vendedor:user-1",
      expect.any(String),
      10
    );
    expect(handle?.lockKey).toBe("lock:ticket-create:sorteo:sorteo-1:vendedor:user-1");

    await TicketConcurrencyManager.release(handle);
    expect(restrictionHelper.releaseLock).toHaveBeenCalledWith(
      "lock:ticket-create:sorteo:sorteo-1:vendedor:user-1",
      handle?.lockValue
    );
  });
});
