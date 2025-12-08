// src/api/v1/services/accounts-export.service.ts
import { AccountsService } from './accounts/accounts.service';
import { AccountsExportCsvService } from './accounts-export-csv.service';
import { AccountsExportExcelService } from './accounts-export-excel.service';
import { AccountsExportPdfService } from './accounts-export-pdf.service';
import {
  AccountStatementExportPayload,
  AccountStatementExportItem,
  AccountStatementSorteoItem,
  AccountMovementItem,
  AccountStatementTotals,
  ExportFormat,
  AccountStatementExportOptions,
} from '../types/accounts-export.types';
import { AccountsFilters, DayStatement } from './accounts/accounts.types';
import { getSorteoBreakdownBatch } from './accounts/accounts.queries';
import prisma from '../../../core/prismaClient';
import logger from '../../../core/logger';
import { resolveDateRange } from '../../../utils/dateRange';

/**
 * Servicio orquestador para exportación de estados de cuenta
 */
export class AccountsExportService {
  /**
   * Genera archivo de exportación en el formato solicitado
   */
  static async export(
    filters: AccountsFilters,
    options: AccountStatementExportOptions
  ): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
    try {
      // 1. Obtener estado de cuenta principal
      const statementResponse = await AccountsService.getStatement(filters);

      // 2. Extraer metadata
      const { statements, totals, monthlyAccumulated, meta } = statementResponse;

      // 3. Resolver nombres de entidades para metadata
      let ventanaName: string | undefined = undefined;
      let vendedorName: string | undefined = undefined;
      let ventanaCode: string | null = null;
      let vendedorCode: string | null = null;

      if (filters.ventanaId) {
        const ventana = await prisma.ventana.findUnique({
          where: { id: filters.ventanaId },
          select: { name: true, code: true },
        });
        ventanaName = ventana?.name;
        ventanaCode = ventana?.code || null;
      }

      if (filters.vendedorId) {
        const vendedor = await prisma.user.findUnique({
          where: { id: filters.vendedorId },
          select: { name: true, code: true },
        });
        vendedorName = vendedor?.name;
        vendedorCode = vendedor?.code || null;
      }

      // 4. Transformar statements a formato de exportación
      const exportStatements: AccountStatementExportItem[] = await this.transformStatements(
        statements,
        filters.dimension
      );

      // 5. Obtener breakdown por sorteo (si está habilitado)
      let breakdown: AccountStatementSorteoItem[] | undefined = undefined;
      if (options.includeBreakdown && statements.length > 0) {
        breakdown = await this.getBreakdown(statements, filters);
      }

      // 6. Obtener movimientos (si está habilitado)
      let movements: AccountMovementItem[] | undefined = undefined;
      if (options.includeMovements && statements.length > 0) {
        movements = await this.getMovements(statements, filters.dimension);
      }

      // 7. Transformar totales
      const exportTotals: AccountStatementTotals = {
        totalSales: totals.totalSales,
        totalPayouts: totals.totalPayouts,
        totalListeroCommission: totals.totalListeroCommission || 0,
        totalVendedorCommission: totals.totalVendedorCommission || 0,
        totalBalance: totals.totalBalance,
        totalPaid: totals.totalPaid,
        totalCollected: totals.totalCollected,
        totalRemainingBalance: totals.totalRemainingBalance,
        settledDays: totals.settledDays,
        pendingDays: totals.pendingDays,
      };

      const exportMonthlyAccumulated: AccountStatementTotals = {
        totalSales: monthlyAccumulated.totalSales,
        totalPayouts: monthlyAccumulated.totalPayouts,
        totalListeroCommission: monthlyAccumulated.totalListeroCommission || 0,
        totalVendedorCommission: monthlyAccumulated.totalVendedorCommission || 0,
        totalBalance: monthlyAccumulated.totalBalance,
        totalPaid: monthlyAccumulated.totalPaid,
        totalCollected: monthlyAccumulated.totalCollected,
        totalRemainingBalance: monthlyAccumulated.totalRemainingBalance,
        settledDays: monthlyAccumulated.settledDays,
        pendingDays: monthlyAccumulated.pendingDays,
      };

      // 8. Construir payload completo
      const payload: AccountStatementExportPayload = {
        statements: exportStatements,
        breakdown,
        movements,
        totals: exportTotals,
        monthlyAccumulated: exportMonthlyAccumulated,
        metadata: {
          generatedAt: new Date(),
          timezone: 'America/Costa_Rica',
          month: meta.month,
          startDate: meta.startDate,
          endDate: meta.endDate,
          monthStartDate: meta.monthStartDate,
          monthEndDate: meta.monthEndDate,
          filters: {
            scope: filters.scope,
            dimension: filters.dimension,
            ventanaId: filters.ventanaId,
            ventanaName,
            vendedorId: filters.vendedorId,
            vendedorName,
            bancaId: filters.bancaId,
          },
          totalDays: meta.totalDays,
        },
      };

      // 9. Generar archivo según formato
      let buffer: Buffer;
      let mimeType: string;

      switch (options.format) {
        case 'csv':
          buffer = AccountsExportCsvService.generate(payload);
          mimeType = 'text/csv; charset=utf-8';
          break;
        case 'excel':
          buffer = await AccountsExportExcelService.generate(payload);
          mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
          break;
        case 'pdf':
          buffer = await AccountsExportPdfService.generate(payload);
          mimeType = 'application/pdf';
          break;
        default:
          throw new Error(`Formato de exportación no soportado: ${options.format}`);
      }

      // 10. Generar nombre de archivo
      const filename = this.generateFilename(
        options.format,
        filters,
        meta.startDate,
        meta.endDate,
        ventanaName,
        ventanaCode,
        vendedorName,
        vendedorCode
      );

      logger.info({
        layer: 'service',
        action: 'ACCOUNTS_EXPORT',
        payload: {
          format: options.format,
          filters,
          dateRange: { from: meta.startDate, to: meta.endDate },
          recordCount: exportStatements.length,
          breakdownCount: breakdown?.length || 0,
          movementsCount: movements?.length || 0,
          filename,
        },
      });

      return { buffer, filename, mimeType };
    } catch (err: any) {
      logger.error({
        layer: 'service',
        action: 'ACCOUNTS_EXPORT_FAIL',
        payload: { message: err.message, filters, options },
      });
      throw err;
    }
  }

  /**
   * Transforma statements de DayStatement[] a AccountStatementExportItem[]
   * ✅ OPTIMIZADO: Evita queries cuando los nombres ya están disponibles
   */
  private static async transformStatements(
    statements: DayStatement[],
    dimension: 'ventana' | 'vendedor'
  ): Promise<AccountStatementExportItem[]> {
    // ✅ OPTIMIZACIÓN: Primero recopilar TODOS los IDs únicos (principales + breakdowns)
    const allVentanaIds = new Set<string>();
    const allVendedorIds = new Set<string>();

    // IDs de statements principales
    statements.forEach((s) => {
      if (s.ventanaId) allVentanaIds.add(s.ventanaId);
      if (s.vendedorId) allVendedorIds.add(s.vendedorId);
    });

    // IDs de breakdowns anidados
    statements.forEach((s) => {
      s.byVentana?.forEach((bv) => {
        if (bv.ventanaId) allVentanaIds.add(bv.ventanaId);
      });
      s.byVendedor?.forEach((bv) => {
        if (bv.vendedorId) allVendedorIds.add(bv.vendedorId);
        if (bv.ventanaId) allVentanaIds.add(bv.ventanaId);
      });
    });

    const ventanaMap = new Map<string, { name: string; code: string | null }>();
    const vendedorMap = new Map<string, { name: string; code: string | null }>();

    // ✅ OPTIMIZACIÓN: Una sola query batch para todos los IDs
    if (allVentanaIds.size > 0) {
      const ventanas = await prisma.ventana.findMany({
        where: { id: { in: Array.from(allVentanaIds) } },
        select: { id: true, name: true, code: true },
      });
      ventanas.forEach((v) => ventanaMap.set(v.id, { name: v.name, code: v.code }));
    }

    if (allVendedorIds.size > 0) {
      const vendedores = await prisma.user.findMany({
        where: { id: { in: Array.from(allVendedorIds) } },
        select: { id: true, name: true, code: true },
      });
      vendedores.forEach((v) => vendedorMap.set(v.id, { name: v.name, code: v.code }));
    }

    // Transformar statements
    return statements.map((s) => {
      const ventanaInfo = s.ventanaId ? ventanaMap.get(s.ventanaId) : null;
      const vendedorInfo = s.vendedorId ? vendedorMap.get(s.vendedorId) : null;

      const item: any = {
        date: this.formatDate(s.date),
        ventanaId: s.ventanaId,
        ventanaName: ventanaInfo?.name || null,
        ventanaCode: ventanaInfo?.code || null,
        vendedorId: s.vendedorId,
        vendedorName: vendedorInfo?.name || null,
        vendedorCode: vendedorInfo?.code || null,
        totalSales: s.totalSales,
        totalPayouts: s.totalPayouts,
        listeroCommission: s.listeroCommission,
        vendedorCommission: s.vendedorCommission,
        balance: s.balance,
        totalPaid: s.totalPaid,
        totalCollected: s.totalCollected,
        remainingBalance: s.remainingBalance,
        isSettled: s.isSettled,
        canEdit: s.canEdit,
        ticketCount: s.ticketCount,
      };

      // ✅ NUEVO: Transformar byVentana si existe
      if (s.byVentana && s.byVentana.length > 0) {
        item.byVentana = s.byVentana.map((bv) => {
          const ventanaInfo = ventanaMap.get(bv.ventanaId);
          return {
            ventanaId: bv.ventanaId,
            ventanaName: bv.ventanaName,
            ventanaCode: ventanaInfo?.code || null,
            totalSales: bv.totalSales,
            totalPayouts: bv.totalPayouts,
            listeroCommission: bv.listeroCommission,
            vendedorCommission: bv.vendedorCommission,
            balance: bv.balance,
            totalPaid: bv.totalPaid || 0,
            totalCollected: bv.totalCollected || 0,
            remainingBalance: bv.remainingBalance,
            ticketCount: bv.ticketCount || 0,
          };
        });
      }

      // ✅ NUEVO: Transformar byVendedor si existe
      if (s.byVendedor && s.byVendedor.length > 0) {
        item.byVendedor = s.byVendedor.map((bv) => {
          const vendedorInfo = vendedorMap.get(bv.vendedorId);
          const ventanaInfo = ventanaMap.get(bv.ventanaId);
          return {
            vendedorId: bv.vendedorId,
            vendedorName: bv.vendedorName,
            vendedorCode: vendedorInfo?.code || null,
            ventanaId: bv.ventanaId,
            ventanaName: bv.ventanaName,
            ventanaCode: ventanaInfo?.code || null,
            totalSales: bv.totalSales,
            totalPayouts: bv.totalPayouts,
            listeroCommission: bv.listeroCommission,
            vendedorCommission: bv.vendedorCommission,
            balance: bv.balance,
            totalPaid: bv.totalPaid || 0,
            totalCollected: bv.totalCollected || 0,
            remainingBalance: bv.remainingBalance,
            ticketCount: bv.ticketCount || 0,
          };
        });
      }

      return item;
    });
  }

  /**
   * Obtiene breakdown detallado por sorteo para todos los días
   * ✅ OPTIMIZADO: Usa datos de bySorteo cuando están disponibles en statements agrupados
   */
  private static async getBreakdown(
    statements: DayStatement[],
    filters: AccountsFilters
  ): Promise<AccountStatementSorteoItem[]> {
    const result: AccountStatementSorteoItem[] = [];
    const isDimensionVentana = filters.dimension === 'ventana';
    const hasGrouping = statements.some(
      (s) => (isDimensionVentana && s.byVentana && s.byVentana.length > 0) ||
             (!isDimensionVentana && s.byVendedor && s.byVendedor.length > 0)
    );

    // ✅ OPTIMIZACIÓN: Si hay agrupación, usar bySorteo de los breakdowns anidados
    if (hasGrouping) {
      for (const statement of statements) {
        const dateKey = this.formatDate(statement.date);

        if (isDimensionVentana && statement.byVentana) {
          for (const ventanaBreakdown of statement.byVentana) {
            if (ventanaBreakdown.bySorteo && ventanaBreakdown.bySorteo.length > 0) {
              for (const sorteo of ventanaBreakdown.bySorteo) {
                const scheduledDate = new Date(sorteo.scheduledAt);
                const crTime = new Date(
                  scheduledDate.toLocaleString('en-US', { timeZone: 'America/Costa_Rica' })
                );
                const hours = crTime.getHours();
                const minutes = crTime.getMinutes();
                const ampm = hours >= 12 ? 'PM' : 'AM';
                const displayHours = hours % 12 || 12;
                const sorteoTime = `${displayHours}:${minutes.toString().padStart(2, '0')} ${ampm}`;

                result.push({
                  date: dateKey,
                  ventanaName: ventanaBreakdown.ventanaName,
                  vendedorName: null,
                  loteriaName: sorteo.loteriaName,
                  sorteoTime,
                  totalSales: sorteo.sales,
                  totalPayouts: sorteo.payouts,
                  listeroCommission: sorteo.listeroCommission,
                  vendedorCommission: sorteo.vendedorCommission,
                  balance: sorteo.balance,
                  ticketCount: sorteo.ticketCount,
                });
              }
            }
          }
        } else if (!isDimensionVentana && statement.byVendedor) {
          for (const vendedorBreakdown of statement.byVendedor) {
            if (vendedorBreakdown.bySorteo && vendedorBreakdown.bySorteo.length > 0) {
              for (const sorteo of vendedorBreakdown.bySorteo) {
                const scheduledDate = new Date(sorteo.scheduledAt);
                const crTime = new Date(
                  scheduledDate.toLocaleString('en-US', { timeZone: 'America/Costa_Rica' })
                );
                const hours = crTime.getHours();
                const minutes = crTime.getMinutes();
                const ampm = hours >= 12 ? 'PM' : 'AM';
                const displayHours = hours % 12 || 12;
                const sorteoTime = `${displayHours}:${minutes.toString().padStart(2, '0')} ${ampm}`;

                result.push({
                  date: dateKey,
                  ventanaName: vendedorBreakdown.ventanaName,
                  vendedorName: vendedorBreakdown.vendedorName,
                  loteriaName: sorteo.loteriaName,
                  sorteoTime,
                  totalSales: sorteo.sales,
                  totalPayouts: sorteo.payouts,
                  listeroCommission: sorteo.listeroCommission,
                  vendedorCommission: sorteo.vendedorCommission,
                  balance: sorteo.balance,
                  ticketCount: sorteo.ticketCount,
                });
              }
            }
          }
        }
      }
    } else {
      // ✅ Comportamiento original cuando NO hay agrupación
      const dates = statements.map((s) => new Date(s.date));
      const breakdownMap = await getSorteoBreakdownBatch(
        dates,
        filters.dimension,
        filters.ventanaId,
        filters.vendedorId,
        filters.bancaId,
        filters.userRole || 'ADMIN'
      );

      // Resolver nombres de entidades
      const ventanaIds = Array.from(
        new Set(
          statements
            .map((s) => s.ventanaId)
            .filter((id): id is string => id !== null && id !== undefined)
        )
      );
      const vendedorIds = Array.from(
        new Set(
          statements
            .map((s) => s.vendedorId)
            .filter((id): id is string => id !== null && id !== undefined)
        )
      );

      const ventanaMap = new Map<string, string>();
      const vendedorMap = new Map<string, string>();

      if (ventanaIds.length > 0) {
        const ventanas = await prisma.ventana.findMany({
          where: { id: { in: ventanaIds } },
          select: { id: true, name: true },
        });
        ventanas.forEach((v) => ventanaMap.set(v.id, v.name));
      }

      if (vendedorIds.length > 0) {
        const vendedores = await prisma.user.findMany({
          where: { id: { in: vendedorIds } },
          select: { id: true, name: true },
        });
        vendedores.forEach((v) => vendedorMap.set(v.id, v.name));
      }

      for (const statement of statements) {
        const dateKey = this.formatDate(statement.date);
        const dayBreakdown = breakdownMap.get(dateKey);

        if (dayBreakdown) {
          for (const item of dayBreakdown) {
            const scheduledDate = new Date(item.scheduledAt);
            const crTime = new Date(
              scheduledDate.toLocaleString('en-US', { timeZone: 'America/Costa_Rica' })
            );
            const hours = crTime.getHours();
            const minutes = crTime.getMinutes();
            const ampm = hours >= 12 ? 'PM' : 'AM';
            const displayHours = hours % 12 || 12;
            const sorteoTime = `${displayHours}:${minutes.toString().padStart(2, '0')} ${ampm}`;

            result.push({
              date: dateKey,
              ventanaName: statement.ventanaId ? ventanaMap.get(statement.ventanaId) || null : null,
              vendedorName: statement.vendedorId ? vendedorMap.get(statement.vendedorId) || null : null,
              loteriaName: item.loteriaName,
              sorteoTime,
              totalSales: item.sales,
              totalPayouts: item.payouts,
              listeroCommission: item.listeroCommission,
              vendedorCommission: item.vendedorCommission,
              balance: item.balance,
              ticketCount: item.ticketCount,
            });
          }
        }
      }
    }

    return result;
  }

  /**
   * Obtiene movimientos (pagos/cobros) para todos los días
   * ✅ OPTIMIZADO: Usa datos de movements cuando están disponibles en statements agrupados
   */
  private static async getMovements(
    statements: DayStatement[],
    dimension: 'ventana' | 'vendedor'
  ): Promise<AccountMovementItem[]> {
    const result: AccountMovementItem[] = [];
    const isDimensionVentana = dimension === 'ventana';
    const hasGrouping = statements.some(
      (s) => (isDimensionVentana && s.byVentana && s.byVentana.length > 0) ||
             (!isDimensionVentana && s.byVendedor && s.byVendedor.length > 0)
    );

    // ✅ OPTIMIZACIÓN: Si hay agrupación, usar movements de los breakdowns anidados
    if (hasGrouping) {
      for (const statement of statements) {
        const dateKey = this.formatDate(statement.date);

        if (isDimensionVentana && statement.byVentana) {
          for (const ventanaBreakdown of statement.byVentana) {
            if (ventanaBreakdown.movements && ventanaBreakdown.movements.length > 0) {
              for (const movement of ventanaBreakdown.movements) {
                result.push({
                  movementDate: new Date(movement.createdAt),
                  statementDate: dateKey,
                  ventanaName: ventanaBreakdown.ventanaName,
                  vendedorName: null,
                  type: movement.type === 'payment' ? 'PAGO' : 'COBRO',
                  amount: movement.amount,
                  method: this.translateMethod(movement.method),
                  notes: movement.notes || '',
                  registeredBy: movement.registeredBy || 'Desconocido',
                  status: movement.reversedAt ? 'REVERTIDO' : 'ACTIVO',
                });
              }
            }
          }
        } else if (!isDimensionVentana && statement.byVendedor) {
          for (const vendedorBreakdown of statement.byVendedor) {
            if (vendedorBreakdown.movements && vendedorBreakdown.movements.length > 0) {
              for (const movement of vendedorBreakdown.movements) {
                result.push({
                  movementDate: new Date(movement.createdAt),
                  statementDate: dateKey,
                  ventanaName: vendedorBreakdown.ventanaName,
                  vendedorName: vendedorBreakdown.vendedorName,
                  type: movement.type === 'payment' ? 'PAGO' : 'COBRO',
                  amount: movement.amount,
                  method: this.translateMethod(movement.method),
                  notes: movement.notes || '',
                  registeredBy: movement.registeredBy || 'Desconocido',
                  status: movement.reversedAt ? 'REVERTIDO' : 'ACTIVO',
                });
              }
            }
          }
        }
      }
    } else {
      // ✅ Comportamiento original cuando NO hay agrupación
      const statementIds = statements.map((s) => s.id).filter((id) => id);

      if (statementIds.length === 0) {
        return [];
      }

      const payments = await prisma.accountPayment.findMany({
        where: {
          accountStatementId: { in: statementIds },
        },
        select: {
          id: true,
          accountStatementId: true,
          date: true,
          amount: true,
          type: true,
          method: true,
          notes: true,
          isReversed: true,
          createdAt: true,
          paidBy: {
            select: {
              name: true,
            },
          },
          accountStatement: {
            select: {
              date: true,
              ventanaId: true,
              vendedorId: true,
            },
          },
        },
        orderBy: {
          createdAt: 'asc',
        },
      });

      // Resolver nombres de entidades
      const ventanaIds = Array.from(
        new Set(
          payments
            .map((p) => p.accountStatement?.ventanaId)
            .filter((id): id is string => id !== null && id !== undefined)
        )
      );
      const vendedorIds = Array.from(
        new Set(
          payments
            .map((p) => p.accountStatement?.vendedorId)
            .filter((id): id is string => id !== null && id !== undefined)
        )
      );

      const ventanaMap = new Map<string, string>();
      const vendedorMap = new Map<string, string>();

      if (ventanaIds.length > 0) {
        const ventanas = await prisma.ventana.findMany({
          where: { id: { in: ventanaIds } },
          select: { id: true, name: true },
        });
        ventanas.forEach((v) => ventanaMap.set(v.id, v.name));
      }

      if (vendedorIds.length > 0) {
        const vendedores = await prisma.user.findMany({
          where: { id: { in: vendedorIds } },
          select: { id: true, name: true },
        });
        vendedores.forEach((v) => vendedorMap.set(v.id, v.name));
      }

      for (const p of payments) {
        result.push({
          movementDate: p.createdAt,
          statementDate: this.formatDate(p.accountStatement?.date || p.date),
          ventanaName:
            p.accountStatement?.ventanaId ? ventanaMap.get(p.accountStatement.ventanaId) || null : null,
          vendedorName:
            p.accountStatement?.vendedorId ? vendedorMap.get(p.accountStatement.vendedorId) || null : null,
          type: p.type === 'payment' ? 'PAGO' : 'COBRO',
          amount: p.amount,
          method: this.translateMethod(p.method),
          notes: p.notes,
          registeredBy: p.paidBy?.name || 'Desconocido',
          status: p.isReversed ? 'REVERTIDO' : 'ACTIVO',
        });
      }
    }

    return result;
  }

  /**
   * Genera nombre de archivo según formato y filtros
   */
  private static generateFilename(
    format: ExportFormat,
    filters: AccountsFilters,
    startDate: string,
    endDate: string,
    ventanaName?: string,
    ventanaCode?: string | null,
    vendedorName?: string,
    vendedorCode?: string | null
  ): string {
    const dimension = filters.dimension === 'ventana' ? 'listero' : 'vendedor';
    const ext = format === 'csv' ? 'csv' : format === 'excel' ? 'xlsx' : 'pdf';

    // Determinar filtro
    let filterPart = 'todos';
    if (ventanaName) {
      filterPart = ventanaCode ? `${ventanaCode}` : this.slugify(ventanaName);
    } else if (vendedorName) {
      filterPart = vendedorCode ? `${vendedorCode}` : this.slugify(vendedorName);
    }

    // Determinar período
    let periodPart: string;
    if (startDate === endDate) {
      periodPart = startDate;
    } else {
      periodPart = `${startDate}_${endDate}`;
    }

    return `estado-cuenta-${dimension}-${filterPart}-${periodPart}.${ext}`;
  }

  /**
   * Traduce método de pago a español
   */
  private static translateMethod(method: string): string {
    const translations: Record<string, string> = {
      cash: 'Efectivo',
      transfer: 'Transferencia',
      check: 'Cheque',
      other: 'Otro',
    };
    return translations[method] || method;
  }

  /**
   * Convierte texto a slug (sin acentos, minúsculas, guiones)
   */
  private static slugify(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Formatea Date a YYYY-MM-DD
   */
  private static formatDate(date: Date): string {
    const d = new Date(date);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}
