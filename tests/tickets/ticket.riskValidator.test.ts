/// <reference types="jest" />

jest.mock("uuid", () => ({
  v4: () => "mock-uuid-1234",
}));

import { BetType } from "../../src/generated/prisma/client";
import { ReportDimension } from "../../src/types/enums/report.enum";
import { TicketRiskValidator } from "../../src/domain/ticket/pipeline/TicketRiskValidator";
import {
  ScopeCache,
  validateRulesInParallel,
} from "../../src/repositories/helpers/ticket-restriction.helper";

describe("TicketRiskValidator & Reventado Restriction Rules", () => {
  const loteriaId = "loteria-tica";
  const sorteoId = "sorteo-1";
  const ventanaId = "cen-listero";
  const vendorId = "vendedor-1";
  const reventadoMultId = "mult-reventado-roja";

  const makeRule3000 = (multKind: string = BetType.REVENTADO) =>
    ({
      id: "rule-3000",
      bancaId: "banca-cen",
      ventanaId,
      userId: null,
      number: null,
      maxAmount: null,
      maxTotal: null,
      baseAmount: 3000,
      salesPercentage: null,
      appliesToVendedor: true,
      appliesToDate: null,
      appliesToHour: null,
      isAutoDate: false,
      isActive: true,
      loteriaId,
      multiplierId: reventadoMultId,
      multiplier: {
        id: reventadoMultId,
        name: "REVENTADO ROJA (200x)",
        kind: multKind,
      },
    }) as any;

  const makeRule30000 = (multKind: string = BetType.REVENTADO) =>
    ({
      id: "rule-30000",
      bancaId: "banca-cen",
      ventanaId,
      userId: null,
      number: null,
      maxAmount: null,
      maxTotal: 30000,
      baseAmount: null,
      salesPercentage: null,
      appliesToVendedor: false,
      appliesToDate: null,
      appliesToHour: null,
      isAutoDate: false,
      isActive: true,
      loteriaId,
      multiplierId: reventadoMultId,
      multiplier: {
        id: reventadoMultId,
        name: "REVENTADO ROJA (200x)",
        kind: multKind,
      },
    }) as any;

  it("extractScopesToPreload separa VENDEDOR (appliesToVendedor=true) y VENTANA (appliesToVendedor=false) sin colisión", () => {
    const scopes = TicketRiskValidator.extractScopesToPreload(
      [makeRule3000(), makeRule30000()],
      vendorId
    );

    expect(scopes).toEqual([
      {
        scopeType: ReportDimension.VENDEDOR,
        scopeId: vendorId,
        multiplierFilter: { id: "REVENTADO", kind: BetType.REVENTADO },
      },
      {
        scopeType: ReportDimension.VENTANA,
        scopeId: ventanaId,
        multiplierFilter: { id: "REVENTADO", kind: BetType.REVENTADO },
      },
    ]);
  });

  it("filterRulesRelevantForTicket conserva reglas de REVENTADO aunque LoteriaMultiplier.kind sea NUMERO", () => {
    const relevant = TicketRiskValidator.filterRulesRelevantForTicket(
      [makeRule3000(BetType.NUMERO), makeRule30000(BetType.NUMERO)],
      ["15"],
      [{ type: BetType.REVENTADO, number: "15", reventadoNumber: "15", amount: 1000 }]
    );

    expect(relevant.map((r) => r.id)).toEqual(["rule-3000", "rule-30000"]);
  });

  it("bloquea cuando un vendedor supera ₡3,000 en el mismo número de REVENTADO (aun con regla de ₡30,000 activa)", async () => {
    const cache: ScopeCache = {
      salesTotals: new Map(),
      numberTotals: new Map([
        [`${ReportDimension.VENDEDOR}:${vendorId}:${sorteoId}:REVENTADO`, new Map([["15", 2500]])],
        [`${ReportDimension.VENTANA}:${ventanaId}:${sorteoId}:REVENTADO`, new Map([["15", 2500]])],
      ]),
    };

    const dynamicLimits = new Map<string, number>([["rule-3000", 3000]]);

    await expect(
      validateRulesInParallel({} as any, {
        rules: [makeRule3000(), makeRule30000()],
        numbers: [
          { number: "15", amountForNumber: 1000, type: BetType.REVENTADO, multiplierId: null },
        ],
        sorteoId,
        loteriaId,
        dynamicLimits,
        cache,
        vendedorId: vendorId,
      })
    ).rejects.toThrow(/Disponible ₡500\.00/);
  });

  it("permite vender hasta ₡3,000 por cada número individual al mismo vendedor", async () => {
    const cache: ScopeCache = {
      salesTotals: new Map(),
      numberTotals: new Map([
        [
          `${ReportDimension.VENDEDOR}:${vendorId}:${sorteoId}:REVENTADO`,
          new Map([
            ["15", 3000],
            ["20", 0],
          ]),
        ],
        [
          `${ReportDimension.VENTANA}:${ventanaId}:${sorteoId}:REVENTADO`,
          new Map([
            ["15", 3000],
            ["20", 0],
          ]),
        ],
      ]),
    };

    const dynamicLimits = new Map<string, number>([["rule-3000", 3000]]);

    await expect(
      validateRulesInParallel({} as any, {
        rules: [makeRule3000(), makeRule30000()],
        numbers: [
          { number: "20", amountForNumber: 3000, type: BetType.REVENTADO, multiplierId: null },
        ],
        sorteoId,
        loteriaId,
        dynamicLimits,
        cache,
        vendedorId: vendorId,
      })
    ).resolves.toBeUndefined();
  });

  it("bloquea por regla de ₡30,000 a nivel de listero cuando la suma de vendedores supera ₡30,000 en un número", async () => {
    const cache: ScopeCache = {
      salesTotals: new Map(),
      numberTotals: new Map([
        [`${ReportDimension.VENDEDOR}:${vendorId}:${sorteoId}:REVENTADO`, new Map([["15", 0]])],
        [`${ReportDimension.VENTANA}:${ventanaId}:${sorteoId}:REVENTADO`, new Map([["15", 29500]])],
      ]),
    };

    const dynamicLimits = new Map<string, number>([["rule-3000", 3000]]);

    await expect(
      validateRulesInParallel({} as any, {
        rules: [makeRule3000(BetType.NUMERO), makeRule30000(BetType.NUMERO)],
        numbers: [
          { number: "15", amountForNumber: 1000, type: BetType.REVENTADO, multiplierId: null },
        ],
        sorteoId,
        loteriaId,
        dynamicLimits,
        cache,
        vendedorId: vendorId,
      })
    ).rejects.toThrow(/Disponible ₡500\.00/);
  });
});
