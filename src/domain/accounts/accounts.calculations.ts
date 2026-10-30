// src/domain/accounts/accounts.calculations.ts
/**
 * Accounts Calculations Facade
 * 
 * Actúa como Facade liviana delegando la ejecución del cálculo de estados de cuenta al motor modular:
 * - StatementEngine: Orquestador del pipeline de cálculo.
 * - StatementQueryBuilder: Extracción y agregación SQL en base de datos.
 * - StatementAccumulatorEngine: Arrastre progresivo de saldos, carry-over y monthlyAccumulated.
 * - StatementInterleavingFormatter: Intercalación cronológica de sorteos y movimientos.
 * - Strategies (Banca, Ventana, Vendedor): Resolución polimórfica según dimensión.
 * - DayStatementCalculator: Cálculo individual de estados de cuenta por día.
 * - SettledStatementsHelper: Gestión de estados asentados y exclusiones.
 *
 * Mantiene 100% de compatibilidad (CERO breaking changes) con todas las firmas y tipos públicos preexistentes.
 */

import { Role } from "../../generated/prisma/client";
import { StatementEngine } from "./engine/statement.engine";
import { calculateDayStatement } from "./engine/day-statement.calculator";
import {
  getExcludedTicketIdsForDate,
  getSettledStatements,
  getDatesNotSettled,
  combineSettledAndCalculated,
} from "./engine/settled-statements.helper";
import {
  AccountsFilters,
  StatementResponse,
  DayStatement,
} from "./engine/types/statement.types";

// Re-exportar tipos y utilidades públicas
export * from "./engine/types/statement.types";
export { StatementEngine } from "./engine/statement.engine";
export { StatementQueryBuilder } from "./engine/statement-query.builder";
export { StatementAccumulatorEngine } from "./engine/statement-accumulator.engine";
export { StatementInterleavingFormatter } from "./engine/statement-interleaving.formatter";
export { calculateDayStatement } from "./engine/day-statement.calculator";
export {
  getExcludedTicketIdsForDate,
  getSettledStatements,
  getDatesNotSettled,
  combineSettledAndCalculated,
} from "./engine/settled-statements.helper";

/**
 * Calcula el estado de cuenta directo mediante el motor de cálculo segregado
 */
export async function getStatementDirect(
  filters: AccountsFilters,
  startDate: Date,
  endDate: Date,
  daysInMonth: number,
  effectiveMonth: string,
  dimension: "banca" | "ventana" | "vendedor",
  ventanaId?: string,
  vendedorId?: string,
  bancaId?: string,
  userRole: Role = Role.ADMIN,
  sort: "asc" | "desc" = "desc"
): Promise<StatementResponse> {
  return StatementEngine.execute({
    filters,
    startDate,
    endDate,
    daysInMonth,
    effectiveMonth,
    dimension,
    ventanaId,
    vendedorId,
    bancaId,
    userRole,
    sort,
  });
}
