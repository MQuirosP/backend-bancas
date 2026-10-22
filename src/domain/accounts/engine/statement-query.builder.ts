// src/domain/accounts/engine/statement-query.builder.ts

import prisma from "../../../core/prismaClient";
import { crDateService } from "../../../utils/crDateService";
import { getAggregatedTicketsData, getSorteoBreakdownBatch, AggregatedTicketRow } from "../accounts.queries";
import { AccountPaymentRepository } from "../../../repositories/accountPayment.repository";
import { ResolvedEntityNames, StatementDimension } from "./types/statement.types";
import { Role } from "../../../generated/prisma/client";

export class StatementQueryBuilder {
  /**
   * Resuelve nombres y códigos de las entidades involucradas en paralelo
   */
  static async resolveEntityNames(
    bancaId?: string,
    ventanaId?: string,
    vendedorId?: string
  ): Promise<ResolvedEntityNames> {
    const [b, v, ven] = await Promise.all([
      bancaId ? prisma.banca.findUnique({ where: { id: bancaId }, select: { name: true, code: true } }) : Promise.resolve(null),
      ventanaId ? prisma.user.findUnique({ where: { id: ventanaId }, select: { name: true, code: true } }) : Promise.resolve(null),
      vendedorId ? prisma.user.findUnique({ where: { id: vendedorId }, select: { name: true, code: true } }) : Promise.resolve(null),
    ]);

    return {
      resolvedBancaName: b?.name || null,
      resolvedBancaCode: b?.code || null,
      resolvedVentanaName: v?.name || null,
      resolvedVentanaCode: (v?.code as string | null) || null,
      resolvedVendedorName: ven?.name || null,
      resolvedVendedorCode: (ven?.code as string | null) || null,
    };
  }

  /**
   * Resuelve la fecha de corte balanceResetAt si está configurada para el vendedor
   */
  static async resolveBalanceResetDay(
    vendedorId?: string,
    ignoreReset?: boolean
  ): Promise<string | null> {
    if (!vendedorId || ignoreReset) {
      return null;
    }
    const user = await prisma.user.findUnique({
      where: { id: vendedorId },
      select: { settings: true },
    });
    if (user?.settings && (user.settings as Record<string, any>).balanceResetAt) {
      const balanceResetAt = new Date((user.settings as Record<string, any>).balanceResetAt);
      return crDateService.dateUTCToCRString(balanceResetAt);
    }
    return null;
  }

  /**
   * Consulta agregaciones de tickets directamente desde PostgreSQL
   */
  static async fetchAggregatedTickets(params: {
    startDate: Date;
    endDate: Date;
    dimension: StatementDimension;
    bancaId?: string;
    ventanaId?: string;
    vendedorId?: string;
    daysInMonth: number;
    shouldGroupByDate: boolean;
    sort: "asc" | "desc";
    isToday: boolean;
    monthStartDateForQuery: string;
  }): Promise<AggregatedTicketRow[]> {
    return getAggregatedTicketsData({
      startDate: params.startDate,
      endDate: params.endDate,
      dimension: params.dimension,
      bancaId: params.bancaId,
      ventanaId: params.ventanaId,
      vendedorId: params.vendedorId,
      daysInMonth: params.daysInMonth,
      shouldGroupByDate: params.shouldGroupByDate,
      sort: params.sort,
      isToday: params.isToday,
      monthStartDateForQuery: params.monthStartDateForQuery,
    });
  }

  /**
   * Obtiene movimientos (pagos/cobros) para el rango consultado
   */
  static async fetchMovements(
    monthStartDateForQuery: Date,
    endDate: Date,
    dimension: StatementDimension,
    ventanaId?: string,
    vendedorId?: string,
    bancaId?: string
  ) {
    return AccountPaymentRepository.findMovementsByDateRange(
      monthStartDateForQuery,
      endDate,
      dimension,
      ventanaId,
      vendedorId,
      bancaId,
      dimension === "banca" // includeChildren: true para banca para ver movimientos de listeros
    );
  }

  /**
   * Obtiene desglose por sorteo en batch
   */
  static async fetchSorteoBreakdownBatch(
    statementDates: Date[],
    dimension: StatementDimension,
    ventanaId?: string,
    vendedorId?: string,
    bancaId?: string,
    userRole?: Role
  ) {
    return getSorteoBreakdownBatch(
      statementDates,
      dimension,
      ventanaId,
      vendedorId,
      bancaId,
      userRole
    );
  }

  /**
   * Pre-carga AccountStatements para acelerar búsquedas de saldo acumulado anterior
   */
  static async preloadStatements(
    previousDayOfFirst: Date,
    lastDate: Date,
    dimension: StatementDimension,
    shouldGroupByDate: boolean,
    bancaId?: string,
    ventanaId?: string,
    vendedorId?: string
  ): Promise<Map<string, Map<string, any>>> {
    const preloadedStatementsMap = new Map<string, Map<string, any>>();

    if (shouldGroupByDate && dimension === "banca" && !bancaId) {
      const preloadedStatements = await prisma.accountStatement.findMany({
        where: {
          date: {
            gte: previousDayOfFirst,
            lte: lastDate,
          },
          bancaId: { not: null },
          ventanaId: null,
          vendedorId: null,
        },
        select: {
          date: true,
          bancaId: true,
          remainingBalance: true,
          accumulatedBalance: true,
        },
      });

      for (const stmt of preloadedStatements) {
        const balanceToUse = stmt.remainingBalance !== null ? stmt.remainingBalance : stmt.accumulatedBalance;
        if (balanceToUse !== null) {
          const dateStr = crDateService.postgresDateToCRString(stmt.date);
          if (!preloadedStatementsMap.has(dateStr)) {
            preloadedStatementsMap.set(dateStr, new Map());
          }
          const dateMap = preloadedStatementsMap.get(dateStr)!;
          const existing = dateMap.get('_consolidado') || 0;
          const existingValue = typeof existing === 'number' ? existing : (existing?.remainingBalance || existing?.accumulatedBalance || 0);
          dateMap.set('_consolidado', existingValue + Number(balanceToUse));
        }
      }
    } else {
      const whereClause: any = {
        date: {
          gte: previousDayOfFirst,
          lte: lastDate,
        },
      };

      if (dimension === "vendedor") {
        whereClause.vendedorId = vendedorId ? vendedorId : { not: null };
      } else if (dimension === "ventana") {
        whereClause.ventanaId = ventanaId ? ventanaId : { not: null };
        whereClause.vendedorId = null;
      } else if (dimension === "banca") {
        whereClause.bancaId = bancaId ? bancaId : { not: null };
        whereClause.ventanaId = null;
        whereClause.vendedorId = null;
      }

      const preloadedStatements = await prisma.accountStatement.findMany({
        where: whereClause,
        select: {
          id: true,
          date: true,
          bancaId: true,
          ventanaId: true,
          vendedorId: true,
          accumulatedBalance: true,
          remainingBalance: true,
          updatedAt: true,
        },
        orderBy: {
          updatedAt: 'desc',
        },
      });

      for (const stmt of preloadedStatements) {
        if (stmt.remainingBalance !== null || stmt.accumulatedBalance !== null) {
          const dateStr = crDateService.postgresDateToCRString(stmt.date);
          if (!preloadedStatementsMap.has(dateStr)) {
            preloadedStatementsMap.set(dateStr, new Map());
          }
          const dateMap = preloadedStatementsMap.get(dateStr)!;
          const balanceToUse = stmt.remainingBalance !== null ? stmt.remainingBalance : stmt.accumulatedBalance;
          
          const entityKey = dimension === "banca"
            ? (stmt.bancaId || 'null')
            : dimension === "ventana"
              ? (stmt.ventanaId || 'null')
              : (stmt.vendedorId || 'null');

          if (!dateMap.has(entityKey)) {
            dateMap.set(entityKey, Number(balanceToUse));
          }
        }
      }
    }

    return preloadedStatementsMap;
  }
}
