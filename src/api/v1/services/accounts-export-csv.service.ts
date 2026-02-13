// src/api/v1/services/accounts-export-csv.service.ts
import { AccountStatementExportPayload } from '../types/accounts-export.types';

/**
 * Servicio para exportar estados de cuenta a CSV
 */
export class AccountsExportCsvService {
  /**
   * Genera CSV con BOM para compatibilidad con Excel
   */
  static generate(payload: AccountStatementExportPayload): Buffer {
    const lines: string[] = [];

    // BOM para UTF-8 (para que Excel abra correctamente los caracteres especiales)
    const BOM = '\uFEFF';

    // Metadata del reporte
    lines.push('Estado de Cuenta');
    lines.push(`Generado,${this.formatDateTime(payload.metadata.generatedAt)} (GMT-6)`);
    lines.push(
      `Período,${this.formatDate(payload.metadata.startDate)} - ${this.formatDate(payload.metadata.endDate)}`
    );
    lines.push(
      `Dimensión,${payload.metadata.filters.dimension === 'ventana' ? 'Listeros' : 'Vendedores'}`
    );

    if (payload.metadata.filters.ventanaName) {
      lines.push(`Listero,${payload.metadata.filters.ventanaName}`);
    }
    if (payload.metadata.filters.vendedorName) {
      lines.push(`Vendedor,${payload.metadata.filters.vendedorName}`);
    }

    lines.push(''); // Línea vacía

    // Resumen principal
    lines.push(this.generateSummarySection(payload));

    // Totales
    lines.push(''); // Línea vacía
    lines.push(this.generateTotalsSection(payload));

    return Buffer.from(BOM + lines.join('\n'), 'utf-8');
  }

  /**
   * Genera sección de resumen por día
   */
  private static generateSummarySection(payload: AccountStatementExportPayload): string {
    const lines: string[] = [];
    const isDimensionVentana = payload.metadata.filters.dimension === 'ventana';

    // Encabezado
    if (isDimensionVentana) {
      lines.push(
        'Fecha,Listero,Ventas,Premios,Com. Listero,Com. Vendedor,Balance,Pagado,Cobrado,Saldo,Tickets'
      );
    } else {
      lines.push(
        'Fecha,Vendedor,Ventas,Premios,Com. Vendedor,Com. Listero,Balance,Pagado,Cobrado,Saldo,Tickets'
      );
    }

    // Datos
    for (const item of payload.statements) {
      const date = this.formatDate(item.date);

      // Detectar si hay agrupación (byVentana o byVendedor presente)
      const hasGrouping = (isDimensionVentana && item.byVentana && item.byVentana.length > 0) ||
        (!isDimensionVentana && item.byVendedor && item.byVendedor.length > 0);

      if (hasGrouping) {
        // Fila de total consolidado con "TODOS"
        const totalEntity = 'TODOS';

        if (isDimensionVentana) {
          lines.push(
            `${date},${this.escapeCsv(totalEntity)},` +
            `${this.formatCurrency(item.totalSales)},` +
            `${this.formatCurrency(item.totalPayouts)},` +
            `${this.formatCurrency(item.listeroCommission)},` +
            `${this.formatCurrency(item.vendedorCommission)},` +
            `${this.formatCurrency(item.balance)},` +
            `${this.formatCurrency(item.totalPaid)},` +
            `${this.formatCurrency(item.totalCollected)},` +
            `${this.formatCurrency(item.remainingBalance)},` +
            `${item.ticketCount}`
          );
        } else {
          lines.push(
            `${date},${this.escapeCsv(totalEntity)},` +
            `${this.formatCurrency(item.totalSales)},` +
            `${this.formatCurrency(item.totalPayouts)},` +
            `${this.formatCurrency(item.vendedorCommission)},` +
            `${this.formatCurrency(item.listeroCommission)},` +
            `${this.formatCurrency(item.balance)},` +
            `${this.formatCurrency(item.totalPaid)},` +
            `${this.formatCurrency(item.totalCollected)},` +
            `${this.formatCurrency(item.remainingBalance)},` +
            `${item.ticketCount}`
          );
        }

        // Detalle intercalado para el statement principal si tiene
        if (item.bySorteo && item.bySorteo.length > 0) {
          this.addInterleavedRows(lines, item.bySorteo, false);
        }

        // Filas de desglose por entidad
        if (isDimensionVentana && item.byVentana) {
          for (const breakdown of item.byVentana) {
            const breakdownEntity = `  - ${breakdown.ventanaName}`;
            lines.push(
              `${date},${this.escapeCsv(breakdownEntity)},` +
              `${this.formatCurrency(breakdown.totalSales)},` +
              `${this.formatCurrency(breakdown.totalPayouts)},` +
              `${this.formatCurrency(breakdown.listeroCommission)},` +
              `${this.formatCurrency(breakdown.vendedorCommission)},` +
              `${this.formatCurrency(breakdown.balance)},` +
              `${this.formatCurrency(breakdown.totalPaid || 0)},` +
              `${this.formatCurrency(breakdown.totalCollected || 0)},` +
              `${this.formatCurrency(breakdown.remainingBalance)},` +
              `${breakdown.ticketCount || 0}`
            );

            if (breakdown.bySorteo && breakdown.bySorteo.length > 0) {
              this.addInterleavedRows(lines, breakdown.bySorteo, true);
            }
          }
        } else if (!isDimensionVentana && item.byVendedor) {
          for (const breakdown of item.byVendedor) {
            const breakdownEntity = `  - ${breakdown.vendedorName}`;
            lines.push(
              `${date},${this.escapeCsv(breakdownEntity)},` +
              `${this.formatCurrency(breakdown.totalSales)},` +
              `${this.formatCurrency(breakdown.totalPayouts)},` +
              `${this.formatCurrency(breakdown.vendedorCommission)},` +
              `${this.formatCurrency(breakdown.listeroCommission)},` +
              `${this.formatCurrency(breakdown.balance)},` +
              `${this.formatCurrency(breakdown.totalPaid || 0)},` +
              `${this.formatCurrency(breakdown.totalCollected || 0)},` +
              `${this.formatCurrency(breakdown.remainingBalance)},` +
              `${breakdown.ticketCount || 0}`
            );

            if (breakdown.bySorteo && breakdown.bySorteo.length > 0) {
              this.addInterleavedRows(lines, breakdown.bySorteo, true);
            }
          }
        }
      } else {
        // Comportamiento normal cuando NO hay agrupación
        const entity = isDimensionVentana
          ? this.escapeCsv(item.ventanaName || '-')
          : this.escapeCsv(item.vendedorName || '-');

        if (isDimensionVentana) {
          lines.push(
            `${date},${entity},` +
            `${this.formatCurrency(item.totalSales)},` +
            `${this.formatCurrency(item.totalPayouts)},` +
            `${this.formatCurrency(item.listeroCommission)},` +
            `${this.formatCurrency(item.vendedorCommission)},` +
            `${this.formatCurrency(item.balance)},` +
            `${this.formatCurrency(item.totalPaid)},` +
            `${this.formatCurrency(item.totalCollected)},` +
            `${this.formatCurrency(item.remainingBalance)},` +
            `${item.ticketCount}`
          );
        } else {
          lines.push(
            `${date},${entity},` +
            `${this.formatCurrency(item.totalSales)},` +
            `${this.formatCurrency(item.totalPayouts)},` +
            `${this.formatCurrency(item.vendedorCommission)},` +
            `${this.formatCurrency(item.listeroCommission)},` +
            `${this.formatCurrency(item.balance)},` +
            `${this.formatCurrency(item.totalPaid)},` +
            `${this.formatCurrency(item.totalCollected)},` +
            `${this.formatCurrency(item.remainingBalance)},` +
            `${item.ticketCount}`
          );
        }

        if (item.bySorteo && item.bySorteo.length > 0) {
          this.addInterleavedRows(lines, item.bySorteo, false);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Genera sección de totales
   */
  private static generateTotalsSection(payload: AccountStatementExportPayload): string {
    const lines: string[] = [];
    const isDimensionVentana = payload.metadata.filters.dimension === 'ventana';

    // Totales del período
    lines.push('TOTALES DEL PERÍODO');

    if (isDimensionVentana) {
      lines.push(`Total Ventas,${this.formatCurrency(payload.totals.totalSales)}`);
      lines.push(`Total Premios,${this.formatCurrency(payload.totals.totalPayouts)}`);
      lines.push(
        `Total Comisión Listero,${this.formatCurrency(payload.totals.totalListeroCommission)}`
      );
      lines.push(
        `Total Comisión Vendedor,${this.formatCurrency(payload.totals.totalVendedorCommission)}`
      );
      lines.push(`Total Balance,${this.formatCurrency(payload.totals.totalBalance)}`);
      lines.push(`Total Pagado,${this.formatCurrency(payload.totals.totalPaid)}`);
      lines.push(`Total Cobrado,${this.formatCurrency(payload.totals.totalCollected)}`);
      lines.push(`Saldo Final,${this.formatCurrency(payload.totals.totalRemainingBalance)}`);
      lines.push(`Días Liquidados,${payload.totals.settledDays}`);
      lines.push(`Días Pendientes,${payload.totals.pendingDays}`);
    } else {
      lines.push(`Total Ventas,${this.formatCurrency(payload.totals.totalSales)}`);
      lines.push(`Total Premios,${this.formatCurrency(payload.totals.totalPayouts)}`);
      lines.push(
        `Total Comisión Vendedor,${this.formatCurrency(payload.totals.totalVendedorCommission)}`
      );
      lines.push(
        `Total Comisión Listero,${this.formatCurrency(payload.totals.totalListeroCommission)}`
      );
      lines.push(`Total Balance,${this.formatCurrency(payload.totals.totalBalance)}`);
      lines.push(`Total Pagado,${this.formatCurrency(payload.totals.totalPaid)}`);
      lines.push(`Total Cobrado,${this.formatCurrency(payload.totals.totalCollected)}`);
      lines.push(`Saldo Final,${this.formatCurrency(payload.totals.totalRemainingBalance)}`);
      lines.push(`Días Liquidados,${payload.totals.settledDays}`);
      lines.push(`Días Pendientes,${payload.totals.pendingDays}`);
    }

    // Saldo a Hoy (acumulado del mes)
    if (payload.monthlyAccumulated) {
      lines.push(''); // Línea vacía
      lines.push('SALDO A HOY (MES COMPLETO)');

      if (isDimensionVentana) {
        lines.push(`Total Ventas,${this.formatCurrency(payload.monthlyAccumulated.totalSales)}`);
        lines.push(`Total Premios,${this.formatCurrency(payload.monthlyAccumulated.totalPayouts)}`);
        lines.push(
          `Total Comisión Listero,${this.formatCurrency(payload.monthlyAccumulated.totalListeroCommission)}`
        );
        lines.push(
          `Total Comisión Vendedor,${this.formatCurrency(payload.monthlyAccumulated.totalVendedorCommission)}`
        );
        lines.push(`Total Balance,${this.formatCurrency(payload.monthlyAccumulated.totalBalance)}`);
        lines.push(`Total Pagado,${this.formatCurrency(payload.monthlyAccumulated.totalPaid)}`);
        lines.push(`Total Cobrado,${this.formatCurrency(payload.monthlyAccumulated.totalCollected)}`);
        lines.push(
          `Saldo Final,${this.formatCurrency(payload.monthlyAccumulated.totalRemainingBalance)}`
        );
      } else {
        lines.push(`Total Ventas,${this.formatCurrency(payload.monthlyAccumulated.totalSales)}`);
        lines.push(`Total Premios,${this.formatCurrency(payload.monthlyAccumulated.totalPayouts)}`);
        lines.push(
          `Total Comisión Vendedor,${this.formatCurrency(payload.monthlyAccumulated.totalVendedorCommission)}`
        );
        lines.push(
          `Total Comisión Listero,${this.formatCurrency(payload.monthlyAccumulated.totalListeroCommission)}`
        );
        lines.push(`Total Balance,${this.formatCurrency(payload.monthlyAccumulated.totalBalance)}`);
        lines.push(`Total Pagado,${this.formatCurrency(payload.monthlyAccumulated.totalPaid)}`);
        lines.push(`Total Cobrado,${this.formatCurrency(payload.monthlyAccumulated.totalCollected)}`);
        lines.push(
          `Saldo Final,${this.formatCurrency(payload.monthlyAccumulated.totalRemainingBalance)}`
        );
      }
    }

    return lines.join('\n');
  }

  /**
   * Agrega filas intercaladas (sorteos y movimientos)
   */
  private static addInterleavedRows(lines: string[], interleaved: any[], isNested: boolean): void {
    const indent = isNested ? '    ' : '  ';

    for (const event of interleaved) {
      const isSorteo = !event.type || event.type === 'sorteo';
      const timeStr = event.time || '';

      let detailName = '';
      let salesStr = '';
      let payoutsStr = '';
      let balanceStr = this.formatCurrency(event.balance || 0);
      let accumulatedStr = this.formatCurrency(event.accumulated || 0);
      let listeroComStr = '';
      let vendedorComStr = '';
      let ticketsStr = '';

      if (isSorteo) {
        detailName = `${indent}${timeStr} ${event.loteriaName} - ${event.sorteoName}`;
        salesStr = this.formatCurrency(event.sales || 0);
        payoutsStr = this.formatCurrency(event.payouts || 0);
        listeroComStr = this.formatCurrency(event.listeroCommission || 0);
        vendedorComStr = this.formatCurrency(event.vendedorCommission || 0);
        ticketsStr = (event.ticketCount || 0).toString();
      } else {
        const typeLabel =
          event.type === 'payment' ? 'PAGO' : event.type === 'collection' ? 'COBRO' : 'SALDO INI';
        detailName = `${indent}${timeStr} [${typeLabel}] ${event.sorteoName}${event.notes ? ' - ' + event.notes : ''
          }`;
        const amount = event.amount || 0;
        if (event.type === 'payment') {
          listeroComStr = this.formatCurrency(amount);
        } else if (event.type === 'collection') {
          vendedorComStr = this.formatCurrency(amount);
        }
      }

      lines.push(
        `,${this.escapeCsv(detailName)},` +
        `${salesStr},` +
        `${payoutsStr},` +
        `${listeroComStr},` +
        `${vendedorComStr},` +
        `${balanceStr},,,,` +
        `${accumulatedStr},` +
        `${ticketsStr}`
      );
    }
  }

  /**
   * Formatea número como moneda (sin símbolo para CSV)
   */
  private static formatCurrency(value: number): string {
    if (typeof value !== 'number') return '0.00';
    // Formato simple para CSV (compatible con Excel)
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/,/g, '');
  }

  /**
   * Escapa valores para CSV
   */
  private static escapeCsv(value: string): string {
    if (!value) return '';
    const str = value.toString();
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  /**
   * Formatea fecha de YYYY-MM-DD a DD/MM/YYYY
   */
  private static formatDate(dateStr: string | Date): string {
    if (dateStr instanceof Date) {
      const year = dateStr.getUTCFullYear();
      const month = String(dateStr.getUTCMonth() + 1).padStart(2, '0');
      const day = String(dateStr.getUTCDate()).padStart(2, '0');
      dateStr = `${year}-${month}-${day}`;
    }
    const [year, month, day] = dateStr.split('-');
    return `${day}/${month}/${year}`;
  }

  /**
   * Formatea fecha y hora
   */
  private static formatDateTime(date: Date): string {
    const d = new Date(date);
    const day = d.getDate().toString().padStart(2, '0');
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const year = d.getFullYear();
    const hours = d.getHours().toString().padStart(2, '0');
    const minutes = d.getMinutes().toString().padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  }
}
