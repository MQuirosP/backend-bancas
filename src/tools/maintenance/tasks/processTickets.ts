import prisma from "../../../core/prismaClient";
import { resolveCommission } from "../../../services/commission.resolver";
import { flagAsBoolean } from "../utils/argParser";
import { success, info } from "../utils/logger";
import { TicketRangeOptions } from "../types";
import { fetchTicketBatch, BATCH_SIZE } from "./ticketHelpers";

type ProcessOptions = TicketRangeOptions & {
  normalizeMultipliers: boolean;
  recalcCommissions: boolean;
  dryRun?: boolean;
};

type PolicyRule = {
  min: number;
  max: number;
};

const multiplierCache = new Map<string, number>();
const baseMultiplierCache = new Map<string, number>();

async function bootstrapCaches() {
  if (multiplierCache.size === 0) {
    const multipliers = await prisma.loteriaMultiplier.findMany({
      select: { id: true, valueX: true },
    });
    multipliers.forEach((m) => multiplierCache.set(m.id, m.valueX));
  }

  if (baseMultiplierCache.size === 0) {
    const baseMultipliers = await prisma.bancaLoteriaSetting.findMany({
      select: { bancaId: true, loteriaId: true, baseMultiplierX: true },
    });
    baseMultipliers.forEach((m) => {
      baseMultiplierCache.set(`${m.bancaId}:${m.loteriaId}`, m.baseMultiplierX);
    });
  }
}

function extractRules(policy: any, loteriaId: string, betType: string): PolicyRule[] {
  if (!policy || !Array.isArray(policy.rules)) return [];
  return policy.rules
    .filter((rule: any) => {
      if (rule.loteriaId && rule.loteriaId !== loteriaId) return false;
      if (rule.betType && rule.betType !== betType) return false;
      const min = typeof rule.multiplierRange?.min === "number";
      const max = typeof rule.multiplierRange?.max === "number";
      return min && max;
    })
    .map((rule: any) => ({
      min: rule.multiplierRange.min,
      max: rule.multiplierRange.max,
    }));
}

function clampMultiplier(value: number, rules: PolicyRule[]): number {
  for (const rule of rules) {
    if (value >= rule.min && value <= rule.max) {
      return value;
    }
  }

  if (rules.length === 0) return value;

  const anchors: number[] = [];
  rules.forEach((rule) => {
    anchors.push(rule.min, rule.max);
  });

  let best = anchors[0];
  let bestDist = Math.abs(value - anchors[0]);

  for (let i = 1; i < anchors.length; i++) {
    const dist = Math.abs(value - anchors[i]);
    if (dist < bestDist) {
      best = anchors[i];
      bestDist = dist;
    }
  }

  return best;
}

export async function processTickets(options: ProcessOptions) {
  await bootstrapCaches();

  let cursor: string | undefined;
  let processedTickets = 0;
  let updatedJugadas = 0;

  const startTime = Date.now();

  while (true) {
    const tickets = await fetchTicketBatch({
      cursor,
      from: options.from,
      to: options.to,
      ventanaId: options.ventanaId,
    });

    if (tickets.length === 0) break;

    for (const ticket of tickets) {
      const ventanaPolicy = (ticket.ventana?.commissionPolicyJson as any) ?? null;
      const bancaPolicy = (ticket.ventana?.banca?.commissionPolicyJson as any) ?? null;
      const userPolicy = (ticket.vendedor?.commissionPolicyJson as any) ?? null;
      const bancaId = ticket.ventana?.bancaId;

      const jugadaUpdates = [];
      let ticketCommissionTotal = 0;

      for (const jugada of ticket.jugadas) {
        let multiplier = jugada.finalMultiplierX;

        if (options.normalizeMultipliers) {
          const direct = jugada.multiplierId ? multiplierCache.get(jugada.multiplierId) : undefined;
          if (typeof direct === "number") {
            multiplier = direct;
          } else {
            const rules =
              extractRules(ventanaPolicy, ticket.loteriaId, jugada.type) ??
              extractRules(bancaPolicy, ticket.loteriaId, jugada.type);

            if (rules.length > 0) {
              multiplier = clampMultiplier(multiplier, rules);
            } else if (bancaId) {
              const baseKey = `${bancaId}:${ticket.loteriaId}`;
              if (baseMultiplierCache.has(baseKey)) {
                multiplier = baseMultiplierCache.get(baseKey)!;
              }
            }
          }
        }

        let commissionAmount = jugada.commissionAmount ?? 0;
        let commissionPercent = jugada.commissionPercent ?? 0;
        let commissionOrigin = jugada.commissionOrigin ?? "USER";
        let commissionRuleId = jugada.commissionRuleId ?? null;

        if (options.recalcCommissions) {
          const snapshot = resolveCommission(
            {
              loteriaId: ticket.loteriaId,
              betType: jugada.type as "NUMERO" | "REVENTADO",
              finalMultiplierX: multiplier || 0,
              amount: jugada.amount,
            },
            userPolicy,
            ventanaPolicy,
            bancaPolicy
          );

          commissionAmount = Number(snapshot.commissionAmount.toFixed(2));
          commissionPercent = Number(snapshot.commissionPercent.toFixed(6));
          commissionOrigin = snapshot.commissionOrigin ?? "USER";
          commissionRuleId = snapshot.commissionRuleId;
        }

        ticketCommissionTotal += commissionAmount;
        updatedJugadas += 1;

        if (!options.dryRun) {
          jugadaUpdates.push(
            prisma.jugada.update({
              where: { id: jugada.id },
              data: {
                finalMultiplierX: multiplier,
                commissionAmount,
                commissionPercent,
                commissionOrigin,
                commissionRuleId,
              },
            })
          );
        }
      }

      if (!options.dryRun) {
        await prisma.$transaction([
          ...jugadaUpdates,
          prisma.ticket.update({
            where: { id: ticket.id },
            data: {
              totalCommission: Number(ticketCommissionTotal.toFixed(2)),
            },
          }),
        ]);
      }

      processedTickets += 1;
    }

    cursor = tickets[tickets.length - 1]?.id;
    info(
      `Procesados ${processedTickets} tickets / ${updatedJugadas} jugadas (batch size ${BATCH_SIZE})`
    );
  }

  const seconds = ((Date.now() - startTime) / 1000).toFixed(1);
  success(
    `Finalizado: tickets=${processedTickets}, jugadas=${updatedJugadas}, tiempo=${seconds}s`
  );
}

