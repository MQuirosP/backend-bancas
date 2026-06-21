import { AppError } from "../../../../core/errors";
import { isWithinSalesHours, validateTicketAgainstRules } from "../../../../utils/loteriaRules";

export const TicketValidationService = {
  validateTicketRulesAndHours(sorteo: any, jugadasIn: any[], now: Date) {
    if (jugadasIn.length === 0) {
      throw new AppError("At least one jugada is required", 400);
    }

    // Seguridad: match Numero-Reventado
    const numeros = new Set(
      jugadasIn
        .filter((j) => (j.type ?? "NUMERO") === "NUMERO")
        .map((j) => j.number!)
    );
    for (const j of jugadasIn) {
      if ((j.type ?? "NUMERO") === "REVENTADO") {
        const target = j.reventadoNumber ?? j.number;
        if (!target || !numeros.has(target)) {
          throw new AppError(`REVENTADO requiere NUMERO para ${target}`, 400);
        }
      }
    }

    // Validaciones por rulesJson de la Lotería
    const rules = (sorteo.loteria?.rulesJson ?? {}) as any;
    if (!isWithinSalesHours(now, rules)) {
      throw new AppError("Fuera del horario de ventas", 409);
    }

    const rulesCheck = validateTicketAgainstRules({
      loteriaRules: rules,
      jugadas: jugadasIn.map((j) => ({
        type: (j.type ?? "NUMERO") as "NUMERO" | "REVENTADO",
        number: j.number ?? j.reventadoNumber ?? "",
        amount: j.amount,
        reventadoNumber: j.reventadoNumber ?? undefined,
      })),
    });
    if (!rulesCheck.ok) {
      throw new AppError(rulesCheck.reason, 400);
    }
  }
};
