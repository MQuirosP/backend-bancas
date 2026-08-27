import { BetType } from "../../generated/prisma/client";
import { commissionService } from "../commission/CommissionService";
import { commissionResolver } from "../commission/CommissionResolver";
import {
  CreateTicketInput,
  CreateTicketOptions,
  PreparedCommissions,
  TransactionMeta,
} from "./ticket.types";

export type TicketCommissionContext = {
  data: CreateTicketInput;
  meta: TransactionMeta;
  preparedJugadas: any[];
  options?: CreateTicketOptions;
};

export class TicketCommissionCalculator {
  /**
   * Calcula las comisiones del vendedor y del listero/ventana para cada jugada.
   * Método sincrónico en memoria.
   */
  static calculate(context: TicketCommissionContext): PreparedCommissions {
    const { data, meta, preparedJugadas, options } = context;
    const { loteriaId } = data;
    const { ventana, user, bancaId } = meta;
    const commissionContext = options?.commissionContext;

    const commissionsDetails: any[] = [];
    let jugadasWithCommissions: any[];

    if (commissionContext) {
      const preCalculated =
        commissionService.calculateCommissionsForJugadas(
          preparedJugadas,
          loteriaId,
          commissionContext
        );

      const numeroMultiplierMap = new Map<string, string | null>();
      for (const pj of preparedJugadas) {
        if (pj.type === BetType.NUMERO) {
          numeroMultiplierMap.set(pj.number, pj.multiplierId);
        }
      }

      const ventanaPolicy = ventana?.commissionPolicyJson ?? null;
      const bancaPolicy = ventana?.banca?.commissionPolicyJson ?? null;
      const listeroPolicy = commissionContext.listeroPolicy ?? null;

      jugadasWithCommissions = preCalculated.map((j) => {
        let listeroCommissionAmount = 0;

        if (listeroPolicy) {
          const match = commissionResolver.findMatchingRule(listeroPolicy, {
            loteriaId,
            betType: j.type,
            finalMultiplierX: j.finalMultiplierX,
            amount: j.amount,
          });
          if (match) {
            listeroCommissionAmount = parseFloat(
              ((j.amount * match.percent) / 100).toFixed(2)
            );
          } else {
            const listeroResult =
              commissionService.calculateListeroCommission(
                {
                  loteriaId,
                  betType: j.type,
                  finalMultiplierX: j.finalMultiplierX,
                  amount: j.amount,
                },
                ventanaPolicy,
                bancaPolicy
              );
            listeroCommissionAmount = parseFloat(
              listeroResult.commissionAmount.toFixed(2)
            );
          }
        } else {
          const listeroResult = commissionService.calculateListeroCommission(
            {
              loteriaId,
              betType: j.type,
              finalMultiplierX: j.finalMultiplierX,
              amount: j.amount,
            },
            ventanaPolicy,
            bancaPolicy
          );
          listeroCommissionAmount = parseFloat(
            listeroResult.commissionAmount.toFixed(2)
          );
        }

        return {
          ...j,
          reventadoNumber: j.type === BetType.REVENTADO ? j.number : null,
          multiplierId:
            j.type === BetType.NUMERO
              ? (numeroMultiplierMap.get(j.number) ?? null)
              : null,
          listeroCommissionAmount,
        };
      });

      for (const j of jugadasWithCommissions) {
        commissionsDetails.push({
          origin: j.commissionOrigin,
          ruleId: j.commissionRuleId ?? null,
          percent: j.commissionPercent,
          amount: j.commissionAmount,
          listeroAmount: j.listeroCommissionAmount,
          loteriaId,
          betType: j.type,
          multiplierX: j.finalMultiplierX,
          jugadaAmount: j.amount,
        });
      }
    } else {
      const userPolicy = user?.commissionPolicyJson ?? null;
      const ventanaPolicy = ventana?.commissionPolicyJson ?? null;
      const bancaPolicy = ventana?.banca?.commissionPolicyJson ?? null;

      jugadasWithCommissions = preparedJugadas.map((j) => {
        const res = commissionService.calculateVendedorCommission(
          {
            loteriaId,
            betType: j.type,
            finalMultiplierX: j.finalMultiplierX,
            amount: j.amount,
          },
          userPolicy,
          ventanaPolicy,
          bancaPolicy
        );

        const listeroResult = commissionService.calculateListeroCommission(
          {
            loteriaId,
            betType: j.type,
            finalMultiplierX: j.finalMultiplierX,
            amount: j.amount,
          },
          ventanaPolicy,
          bancaPolicy
        );

        const listeroCommissionAmount = parseFloat(
          listeroResult.commissionAmount.toFixed(2)
        );

        commissionsDetails.push({
          origin: res.commissionOrigin,
          ruleId: res.commissionRuleId ?? null,
          percent: res.commissionPercent,
          amount: res.commissionAmount,
          listeroAmount: listeroCommissionAmount,
          loteriaId,
          betType: j.type,
          multiplierX: j.finalMultiplierX,
          jugadaAmount: j.amount,
          bancaId,
        });

        return {
          type: j.type,
          number: j.number,
          reventadoNumber: j.reventadoNumber ?? null,
          amount: j.amount,
          finalMultiplierX: j.finalMultiplierX,
          commissionPercent: res.commissionPercent,
          commissionAmount: res.commissionAmount,
          commissionOrigin: res.commissionOrigin,
          commissionRuleId: res.commissionRuleId ?? null,
          listeroCommissionAmount,
          multiplierId: j.multiplierId ?? null,
        };
      });
    }

    const totalCommission = jugadasWithCommissions.reduce(
      (sum, j) => sum + (j.commissionAmount || 0),
      0
    );
    const totalListeroCommission = jugadasWithCommissions.reduce(
      (sum, j) => sum + (j.listeroCommissionAmount || 0),
      0
    );

    return {
      jugadasWithCommissions,
      commissionsDetails,
      totalCommission,
      totalListeroCommission,
    };
  }
}
