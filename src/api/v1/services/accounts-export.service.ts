// src/api/v1/services/accounts-export.service.ts
import { AccountsService } from './accounts/accounts.service';
import { validate as isUuid } from 'uuid';
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
import { AccountsFilters, DayStatement, StatementResponse } from './accounts/accounts.types';
import { getSorteoBreakdownBatch } from './accounts/accounts.queries';
import { intercalateSorteosAndMovements } from './accounts/accounts.intercalate';
import { getPreviousMonthFinalBalance } from './accounts/accounts.balances';
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
      const statementResponse = await AccountsService.getStatement(filters) as StatementResponse;

      // 2. Validar estructura de respuesta
      if (!statementResponse || !statementResponse.statements || !Array.isArray(statementResponse.statements)) {
        throw new Error('Respuesta inválida del servicio de estados de cuenta: statements no es un array');
      }

      // 3. Extraer metadata
      const { statements, totals, monthlyAccumulated, meta } = statementResponse;

      // 4. Resolver nombres de entidades para metadata
      let bancaName: string | undefined = undefined; //  NUEVO: Nombre de banca
      let bancaCode: string | null = null; //  NUEVO: Código de banca
      let ventanaName: string | undefined = undefined;
      let vendedorName: string | undefined = undefined;
      let ventanaCode: string | null = null;
      let vendedorCode: string | null = null;

      if (filters.bancaId) {
        //  NUEVO: Resolver información de banca
        const banca = await prisma.banca.findUnique({
          where: { id: filters.bancaId },
          select: { name: true, code: true },
        });
        bancaName = banca?.name;
        bancaCode = banca?.code || null;
      }

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

      // 5. Obtener breakdown por sorteo y movimientos ANTES de transformar (para incluir en statements cuando no hay agrupación)
      const breakdown = await this.getBreakdown(statements, filters);
      const movements = await this.getMovements(statements, filters);

      // 6. Transformar statements a formato de exportación (con breakdown y movements para incluir cuando no hay agrupación)
      const exportStatements: AccountStatementExportItem[] = await this.transformStatements(
        statements,
        filters,
        breakdown,
        movements
      );

      // 8. Transformar totales
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

      // 9. Construir payload completo
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
            bancaId: filters.bancaId,
            bancaName, //  NUEVO
            ventanaId: filters.ventanaId,
            ventanaName,
            vendedorId: filters.vendedorId,
            vendedorName,
          },
          totalDays: meta.totalDays,
        },
      };

      // 10. Generar archivo según formato
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

      // 11. Generar nombre de archivo
      const filename = this.generateFilename(
        options.format,
        filters,
        meta.startDate,
        meta.endDate,
        bancaName, //  NUEVO: Pasar nombre de banca
        bancaCode, //  NUEVO: Pasar código de banca
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
   *  OPTIMIZADO: Evita queries cuando los nombres ya están disponibles
   *  NUEVO: Incluye bySorteo y movements cuando no hay agrupación
   */
  private static async transformStatements(
    statements: DayStatement[],
    filters: AccountsFilters,
    breakdown?: AccountStatementSorteoItem[],
    movements?: AccountMovementItem[]
  ): Promise<AccountStatementExportItem[]> {
    // Validar que statements sea un array válido
    if (!statements || !Array.isArray(statements)) {
      return [];
    }

    //  OPTIMIZACIÓN: Primero recopilar TODOS los IDs únicos (principales + breakdowns)
    const allBancaIds = new Set<string>(); //  NUEVO: IDs de bancas
    const allVentanaIds = new Set<string>();
    const allVendedorIds = new Set<string>();

    // IDs de statements principales
    statements.forEach((s) => {
      if (s.bancaId) allBancaIds.add(s.bancaId); //  NUEVO
      if (s.ventanaId) allVentanaIds.add(s.ventanaId);
      if (s.vendedorId) allVendedorIds.add(s.vendedorId);
    });

    // IDs de breakdowns anidados
    statements.forEach((s) => {
      //  NUEVO: IDs de byBanca
      s.byBanca?.forEach((bb) => {
        if (bb.bancaId) allBancaIds.add(bb.bancaId);
        bb.byVentana?.forEach((bv) => {
          if (bv.ventanaId) allVentanaIds.add(bv.ventanaId);
        });
        bb.byVendedor?.forEach((bv) => {
          if (bv.vendedorId) allVendedorIds.add(bv.vendedorId);
          if (bv.ventanaId) allVentanaIds.add(bv.ventanaId);
        });
      });
      s.byVentana?.forEach((bv) => {
        if (bv.ventanaId) allVentanaIds.add(bv.ventanaId);
      });
      s.byVendedor?.forEach((bv) => {
        if (bv.vendedorId) allVendedorIds.add(bv.vendedorId);
        if (bv.ventanaId) allVentanaIds.add(bv.ventanaId);
      });
    });

    const dimension = filters.dimension;

    const bancaMap = new Map<string, { name: string; code: string | null }>(); //  NUEVO: Mapa de bancas
    const ventanaMap = new Map<string, { name: string; code: string | null }>();
    const vendedorMap = new Map<string, { name: string; code: string | null }>();

    //  OPTIMIZACIÓN: Una sola query batch para todos los IDs de bancas
    if (allBancaIds.size > 0) {
      const bancas = await prisma.banca.findMany({
        where: { id: { in: Array.from(allBancaIds) } },
        select: { id: true, name: true, code: true },
      });
      bancas.forEach((b) => bancaMap.set(b.id, { name: b.name, code: b.code }));
    }

    //  OPTIMIZACIÓN: Una sola query batch para todos los IDs
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

    //  CRÍTICO: Obtener saldo inicial del período para la intercalación
    // Solo si el período incluye el día 1, o si necesitamos arrastrar desde el día anterior al inicio del reporte
    // Para simplificar, calculamos el acumulado progresivamente mientras transformamos
    let runningAccumulated = 0;
    const firstStatement = statements[0];
    if (firstStatement) {
      // El balance inicial del primer día es: remainingBalance - balance
      // (Porque balance incluye todo lo que pasó ese día: ventas - premios - comisiones + pagos - cobros)
      runningAccumulated = (firstStatement.remainingBalance || 0) - (firstStatement.balance || 0);
    }

    // Transformar statements
    return statements.map((s) => {
      const bancaInfo = s.bancaId ? bancaMap.get(s.bancaId) : null; //  NUEVO: Información de banca
      const ventanaInfo = s.ventanaId ? ventanaMap.get(s.ventanaId) : null;
      const vendedorInfo = s.vendedorId ? vendedorMap.get(s.vendedorId) : null;

      const dateKey = this.formatDate(s.date);

      const item: any = {
        id: s.id,
        date: dateKey,
        month: s.month,
        bancaId: s.bancaId || null, //  NUEVO: ID de banca
        bancaName: bancaInfo?.name || null, //  NUEVO: Nombre de banca
        bancaCode: bancaInfo?.code || null, //  NUEVO: Código de banca
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
        totalPaymentsCollections: s.totalPaymentsCollections || (s.totalPaid + s.totalCollected),
        remainingBalance: s.remainingBalance,
        isSettled: s.isSettled,
        canEdit: s.canEdit,
        ticketCount: s.ticketCount,
        createdAt: s.createdAt ? (s.createdAt instanceof Date ? s.createdAt.toISOString() : new Date(s.createdAt).toISOString()) : new Date().toISOString(),
        updatedAt: s.updatedAt ? (s.updatedAt instanceof Date ? s.updatedAt.toISOString() : new Date(s.updatedAt).toISOString()) : new Date().toISOString(),
      };

      //  NUEVO: Intercalar sorteos y movimientos para este statement
      // Esto se usa tanto para el principal como para los breakdowns
      const daySorteos = (breakdown || []).filter((b) => b.date === dateKey);
      const dayMovements = (movements || []).filter((m) => m.statementDate === dateKey);

      // Mapear a formato esperado por intercalateSorteosAndMovements
      const sorteoInputs = daySorteos.map(s => ({
        sorteoId: s.sorteoId,
        sorteoName: s.sorteoName,
        scheduledAt: s.scheduledAt,
        sales: s.totalSales,
        payouts: s.totalPayouts,
        listeroCommission: s.listeroCommission,
        vendedorCommission: s.vendedorCommission,
        balance: s.balance,
        ticketCount: s.ticketCount,
        loteriaId: s.loteriaId,
        loteriaName: s.loteriaName
      }));

      const movementInputs = dayMovements.map(m => ({
        id: m.id,
        type: (m.type === 'PAGO' ? 'payment' : 'collection') as "payment" | "collection",
        amount: m.amount,
        method: m.method,
        notes: m.notes || null,
        isReversed: m.status === 'REVERTIDO',
        createdAt: m.createdAt.toISOString(),
        date: m.statementDate
      }));

      // Intercalar (esta función devuelve el array ordenado DESC y con accumulated calculado)
      const interleaved = intercalateSorteosAndMovements(
        sorteoInputs,
        movementInputs,
        dateKey,
        runningAccumulated
      );

      item.bySorteo = interleaved;

      // Actualizar runningAccumulated para el siguiente día
      runningAccumulated = s.remainingBalance;

      //  NUEVO: Transformar byVentana si existe (con intercalación específica)
      if (s.byVentana && s.byVentana.length > 0) {
        item.byVentana = s.byVentana.map((bv) => {
          const ventanaInfo = ventanaMap.get(bv.ventanaId);
          // Filtrar sorteos y movimientos específicos de esta ventana
          const ventanaSorteos = daySorteos.filter(ds => ds.ventanaId === bv.ventanaId);
          const ventanaMovements = dayMovements.filter(dm => dm.ventanaId === bv.ventanaId);

          const initialAcc = (bv.remainingBalance || 0) - (bv.balance || 0);
          const interleavedV = intercalateSorteosAndMovements(
            ventanaSorteos.map(vs => ({ ...vs, sales: vs.totalSales, payouts: vs.totalPayouts })),
            ventanaMovements.map(vm => ({
              id: vm.id,
              type: (vm.type === 'PAGO' ? 'payment' : 'collection') as "payment" | "collection",
              amount: vm.amount,
              method: vm.method,
              notes: vm.notes || null,
              isReversed: vm.status === 'REVERTIDO',
              createdAt: vm.createdAt.toISOString(),
              date: vm.statementDate
            })),
            dateKey,
            initialAcc
          );

          const breakdownItem: any = {
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
            totalPaymentsCollections: (bv.totalPaid || 0) + (bv.totalCollected || 0),
            remainingBalance: bv.remainingBalance,
            ticketCount: bv.ticketCount || 0,
            bySorteo: interleavedV
          };

          return breakdownItem;
        });
      }

      //  NUEVO: Transformar byVendedor si existe (con intercalación específica)
      if (s.byVendedor && s.byVendedor.length > 0) {
        item.byVendedor = s.byVendedor.map((bv) => {
          const vendedorInfo = vendedorMap.get(bv.vendedorId);
          const ventanaInfo = ventanaMap.get(bv.ventanaId);
          // Filtrar sorteos y movimientos específicos de este vendedor
          const vendedorSorteos = daySorteos.filter(ds => ds.vendedorId === bv.vendedorId);
          const vendedorMovements = dayMovements.filter(dm => dm.vendedorId === bv.vendedorId);

          const initialAcc = (bv.remainingBalance || 0) - (bv.balance || 0);
          const interleavedV = intercalateSorteosAndMovements(
            vendedorSorteos.map(vs => ({ ...vs, sales: vs.totalSales, payouts: vs.totalPayouts })),
            vendedorMovements.map(vm => ({
              id: vm.id,
              type: (vm.type === 'PAGO' ? 'payment' : 'collection') as "payment" | "collection",
              amount: vm.amount,
              method: vm.method,
              notes: vm.notes || null,
              isReversed: vm.status === 'REVERTIDO',
              createdAt: vm.createdAt.toISOString(),
              date: vm.statementDate
            })),
            dateKey,
            initialAcc
          );

          const breakdownItem: any = {
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
            totalPaymentsCollections: (bv.totalPaid || 0) + (bv.totalCollected || 0),
            remainingBalance: bv.remainingBalance,
            ticketCount: bv.ticketCount || 0,
            bySorteo: interleavedV
          };

          return breakdownItem;
        });
      }

      return item;
    });
  }

  /**
   * Obtiene breakdown detallado por sorteo para todos los días
   *  OPTIMIZADO: Usa datos de bySorteo cuando están disponibles en statements agrupados
   */
  private static async getBreakdown(
    statements: DayStatement[],
    filters: AccountsFilters
  ): Promise<AccountStatementSorteoItem[]> {
    const result: AccountStatementSorteoItem[] = [];
    const dates = statements.map((s) => new Date(s.date));

    // 1. Obtener todos los sorteos en batch para el período y dimensión
    const breakdownMap = await getSorteoBreakdownBatch(
      dates,
      filters.dimension,
      filters.ventanaId,
      filters.vendedorId,
      filters.bancaId,
      filters.userRole || 'ADMIN'
    );

    // 2. Resolver nombres y códigos de entidades para el reporte
    const ventanaIds = new Set<string>();
    const vendedorIds = new Set<string>();

    for (const key of breakdownMap.keys()) {
      const parts = key.split('_');
      if (parts.length > 1) {
        const entityId = parts[1];
        if (filters.dimension === 'vendedor' || filters.vendedorId) {
          vendedorIds.add(entityId);
        } else {
          ventanaIds.add(entityId);
        }
      }
    }

    const ventanaMap = new Map<string, { name: string; code: string | null }>();
    const vendedorMap = new Map<string, { name: string; code: string | null; ventanaId?: string; ventanaName?: string }>();

    if (ventanaIds.size > 0) {
      const ventanas = await prisma.ventana.findMany({
        where: { id: { in: Array.from(ventanaIds) } },
        select: { id: true, name: true, code: true },
      });
      ventanas.forEach((v) => ventanaMap.set(v.id, { name: v.name, code: v.code }));
    }

    if (vendedorIds.size > 0) {
      const vendedores = await prisma.user.findMany({
        where: { id: { in: Array.from(vendedorIds) } },
        select: { id: true, name: true, code: true, ventana: { select: { id: true, name: true } } },
      });
      vendedores.forEach((v) => vendedorMap.set(v.id, {
        name: v.name,
        code: v.code,
        ventanaId: v.ventana?.id,
        ventanaName: v.ventana?.name
      }));
    }

    // 3. Aplanar Map a Array de AccountStatementSorteoItem
    for (const [key, sorteos] of breakdownMap.entries()) {
      const parts = key.split('_');
      const dateKey = parts[0];
      const entityId = parts[1];

      for (const s of sorteos) {
        let vId: string | null = null;
        let vName: string | null = null;
        let vCode: string | null = null;
        let vendName: string | null = null;
        let vendId: string | null = null;
        let vendCode: string | null = null;

        if (filters.dimension === 'vendedor' || filters.vendedorId) {
          const vendInfo = vendedorMap.get(entityId);
          vendName = vendInfo?.name || null;
          vendId = entityId;
          vendCode = vendInfo?.code || null;
          vId = vendInfo?.ventanaId || null;
          vName = vendInfo?.ventanaName || null;
        } else {
          const ventInfo = ventanaMap.get(entityId);
          vId = entityId;
          vName = ventInfo?.name || null;
          vCode = ventInfo?.code || null;
        }

        result.push(this.transformSorteoItem(
          s,
          dateKey,
          vId,
          vName,
          vendName,
          vCode,
          vendId,
          vendCode
        ));
      }
    }

    return result;
  }

  /**
   * Obtiene movimientos (pagos/cobros) para todos los días
   *  OPTIMIZADO: Usa datos de movements cuando están disponibles en statements agrupados
   */
  private static async getMovements(
    statements: DayStatement[],
    filters: AccountsFilters
  ): Promise<AccountMovementItem[]> {
    const result: AccountMovementItem[] = [];
    const dimension = filters.dimension;
    const isDimensionBanca = dimension === 'banca';
    const isDimensionVentana = dimension === 'ventana';

    // 1. Recolectar fechas y IDs de statements explícitos
    const dates = statements.map(s => {
      const d = new Date(s.date as string);
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    });

    if (dates.length === 0) return [];

    // IDs de statements persistidos (UUIDs reales)
    const statementIds = statements
      .map(s => s.id)
      .filter(id => id && isUuid(id));

    // 2. Construir query de Prisma flexible
    // Buscamos por statementId O por (dimension + dates) para cubrir agregados
    const where: any = {
      OR: []
    };

    if (statementIds.length > 0) {
      where.OR.push({ accountStatementId: { in: statementIds } });
    }

    // Agregar condiciones por entidad y fecha para atrapar movimientos de statements agregados
    const entityCondition: any = {
      date: { in: dates }
    };

    if (filters.bancaId) entityCondition.bancaId = filters.bancaId;
    if (filters.ventanaId) entityCondition.ventanaId = filters.ventanaId;
    if (filters.vendedorId) entityCondition.vendedorId = filters.vendedorId;

    // Si es un reporte global por dimensión, también debemos incluir movimientos de esa dimensión
    if (!filters.bancaId && isDimensionBanca) entityCondition.bancaId = { not: null };
    if (!filters.ventanaId && isDimensionVentana) entityCondition.ventanaId = { not: null };
    if (!filters.vendedorId && dimension === 'vendedor') entityCondition.vendedorId = { not: null };

    if (Object.keys(entityCondition).length > 1) { // date + al menos uno más
      where.OR.push(entityCondition);
    }

    // Si OR está vacío (no debería pasar), fallar a algo seguro
    if (where.OR.length === 0) {
      return [];
    }

    // 3. Consultar movimientos directamente de la base de datos
    let payments;
    try {
      payments = await prisma.accountPayment.findMany({
        where,
        select: {
          id: true,
          accountStatementId: true,
          date: true,
          amount: true,
          type: true,
          method: true,
          notes: true,
          isReversed: true,
          isFinal: true,
          createdAt: true,
          updatedAt: true,
          reversedAt: true,
          paidBy: { select: { id: true, name: true } },
          reversedByUser: { select: { id: true, name: true } },
          accountStatement: { select: { date: true, ventanaId: true, vendedorId: true } },
          bancaId: true,
          ventanaId: true,
          vendedorId: true,
        },
        orderBy: { createdAt: 'asc' },
      });
    } catch (error: any) {
      logger.error({
        layer: 'service',
        action: 'ACCOUNTS_EXPORT_PAYMENT_QUERY_ERROR',
        payload: { message: error.message },
      });
      throw error;
    }

    // 4. Resolver nombres y códigos de entidades para los movimientos encontrados
    const ventanaIds = new Set<string>();
    const vendedorIds = new Set<string>();

    for (const p of payments) {
      const vId = p.accountStatement?.ventanaId || p.ventanaId;
      const vendId = p.accountStatement?.vendedorId || p.vendedorId;
      if (vId) ventanaIds.add(vId);
      if (vendId) vendedorIds.add(vendId);
    }

    const ventanaMap = new Map<string, { name: string; code: string | null }>();
    const vendedorMap = new Map<string, { name: string; code: string | null }>();

    if (ventanaIds.size > 0) {
      const ventanas = await prisma.ventana.findMany({
        where: { id: { in: Array.from(ventanaIds) } },
        select: { id: true, name: true, code: true },
      });
      ventanas.forEach((v) => ventanaMap.set(v.id, { name: v.name, code: v.code }));
    }

    if (vendedorIds.size > 0) {
      const vendedores = await prisma.user.findMany({
        where: { id: { in: Array.from(vendedorIds) } },
        select: { id: true, name: true, code: true },
      });
      vendedores.forEach((v) => vendedorMap.set(v.id, { name: v.name, code: v.code }));
    }

    // 5. Transformar y devolver
    for (const p of payments) {
      const vId = p.accountStatement?.ventanaId || p.ventanaId;
      const vInfo = vId ? ventanaMap.get(vId) : null;
      const vendId = p.accountStatement?.vendedorId || p.vendedorId;
      const vendInfo = vendId ? vendedorMap.get(vendId) : null;

      result.push(this.transformMovementItem(
        {
          id: p.id,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          accountStatementId: p.accountStatementId,
          ventanaId: vId,
          type: p.type,
          amount: p.amount,
          method: p.method,
          notes: p.notes,
          registeredBy: p.paidBy?.name || 'Desconocido',
          registeredById: p.paidBy?.id || null,
          isReversed: p.isReversed,
          isFinal: p.isFinal || false,
          reversedAt: p.reversedAt,
          reversedBy: p.reversedByUser?.name || null,
          reversedById: p.reversedByUser?.id || null,
        },
        this.formatDate(p.accountStatement?.date || p.date),
        vInfo?.name || null,
        vendInfo?.name || null,
        vInfo?.code || null,
        vendId || null,
        vendInfo?.code || null
      ));
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
    bancaName?: string, //  NUEVO: Nombre de banca
    bancaCode?: string | null, //  NUEVO: Código de banca
    ventanaName?: string,
    ventanaCode?: string | null,
    vendedorName?: string,
    vendedorCode?: string | null
  ): string {
    const dimension = filters.dimension === 'banca' ? 'banca' : filters.dimension === 'ventana' ? 'listero' : 'vendedor';
    const ext = format === 'csv' ? 'csv' : format === 'excel' ? 'xlsx' : 'pdf';

    // Determinar filtro
    let filterPart = 'todos';
    if (bancaName) {
      //  NUEVO: Prioridad a banca
      filterPart = bancaCode ? `${bancaCode}` : this.slugify(bancaName);
    } else if (ventanaName) {
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
  private static formatDate(date: Date | string): string {
    if (typeof date === 'string') return date;
    return date.toISOString().split('T')[0];
  }

  private static transformSorteoItem(
    sorteo: any,
    date: string,
    ventanaId: string | null,
    ventanaName: string | null,
    vendedorName: string | null,
    ventanaCode: string | null,
    vendedorId: string | null,
    vendedorCode: string | null
  ): AccountStatementSorteoItem {
    const scheduledDate = new Date(sorteo.scheduledAt);
    const crTime = new Date(
      scheduledDate.toLocaleString('en-US', { timeZone: 'America/Costa_Rica' })
    );
    const hours = crTime.getHours();
    const minutes = crTime.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    const sorteoTime = `${displayHours}:${minutes.toString().padStart(2, '0')} ${ampm}`;

    return {
      date,
      sorteoId: sorteo.sorteoId,
      sorteoName: sorteo.sorteoName,
      loteriaId: sorteo.loteriaId,
      loteriaName: sorteo.loteriaName,
      scheduledAt: sorteo.scheduledAt,
      sorteoTime,
      ventanaId,
      ventanaName,
      ventanaCode,
      vendedorId,
      vendedorName,
      vendedorCode,
      totalSales: sorteo.sales,
      totalPayouts: sorteo.payouts,
      listeroCommission: sorteo.listeroCommission,
      vendedorCommission: sorteo.vendedorCommission,
      balance: sorteo.balance,
      ticketCount: sorteo.ticketCount,
    };
  }

  /**
   * Transforma un movimiento a formato de exportación con toda la información
   */
  private static transformMovementItem(
    movement: any,
    statementDate: string,
    ventanaName: string | null,
    vendedorName: string | null,
    ventanaCode: string | null,
    vendedorId: string | null,
    vendedorCode: string | null
  ): AccountMovementItem {
    return {
      id: movement.id,
      movementDate: new Date(movement.createdAt),
      statementDate,
      accountStatementId: movement.accountStatementId || '',
      ventanaId: movement.ventanaId || null,
      ventanaName,
      ventanaCode,
      vendedorId,
      vendedorName,
      vendedorCode,
      type: movement.type === 'payment' ? 'PAGO' : 'COBRO',
      amount: movement.amount,
      method: this.translateMethod(movement.method),
      notes: movement.notes || null,
      registeredBy: movement.registeredBy || 'Desconocido',
      registeredById: movement.registeredById || null,
      status: movement.reversedAt || movement.isReversed ? 'REVERTIDO' : 'ACTIVO',
      isFinal: movement.isFinal || false,
      isReversed: movement.reversedAt ? true : (movement.isReversed || false),
      reversedAt: movement.reversedAt ? new Date(movement.reversedAt) : null,
      reversedBy: movement.reversedBy || null,
      reversedById: movement.reversedById || null,
      createdAt: new Date(movement.createdAt),
      updatedAt: movement.updatedAt ? new Date(movement.updatedAt) : new Date(movement.createdAt),
    };
  }
}
