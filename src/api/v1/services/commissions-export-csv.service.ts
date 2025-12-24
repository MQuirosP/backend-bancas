// src/api/v1/services/commissions-export-csv.service.ts
import { CommissionExportPayload } from '../types/commissions-export.types';

/**
 * Servicio para exportar comisiones a CSV
 */
export class CommissionsExportCsvService {
  /**
   * Genera CSV con BOM para compatibilidad con Excel
   */
  static generate(payload: CommissionExportPayload): Buffer {
    const lines: string[] = [];

    // BOM para UTF-8 (para que Excel abra correctamente los caracteres especiales)
    const BOM = '\uFEFF';

    // Metadata del reporte
    lines.push(`Reporte de Comisiones`);
    lines.push(`Generado,${this.formatDateTime(payload.metadata.generatedAt)} (GMT-6)`);
    lines.push(`Período,${this.formatDate(payload.metadata.dateRange.from)} - ${this.formatDate(payload.metadata.dateRange.to)}`);
    lines.push(`Dimensión,${payload.metadata.filters.dimension === 'ventana' ? 'Listeros' : 'Vendedores'}`);

    if (payload.metadata.filters.ventanaName) {
      lines.push(`Listero,${payload.metadata.filters.ventanaName}`);
    }
    if (payload.metadata.filters.vendedorName) {
      lines.push(`Vendedor,${payload.metadata.filters.vendedorName}`);
    }

    lines.push(''); // Línea vacía

    // Resumen principal
    lines.push(this.generateSummarySection(payload));

    // Breakdown detallado (si está incluido)
    if (payload.breakdown && payload.breakdown.length > 0) {
      lines.push(''); // Línea vacía
      lines.push(this.generateBreakdownSection(payload));
    }

    // Advertencias (si están incluidas)
    if (payload.warnings && payload.warnings.length > 0) {
      lines.push(''); // Línea vacía
      lines.push(this.generateWarningsSection(payload));
    }

    // Políticas de comisión (si están incluidas)
    if (payload.policies && payload.policies.length > 0) {
      lines.push(''); // Línea vacía
      lines.push(this.generatePoliciesSection(payload));
    }

    // Totales
    lines.push(''); // Línea vacía
    lines.push(this.generateTotalsSection(payload));

    return Buffer.from(BOM + lines.join('\n'), 'utf-8');
  }

  /**
   * Genera sección de resumen
   */
  private static generateSummarySection(payload: CommissionExportPayload): string {
    const lines: string[] = [];
    const isDimensionVentana = payload.metadata.filters.dimension === 'ventana';

    // Encabezado
    if (isDimensionVentana) {
      lines.push('Fecha,Listero,Total Ventas,Total Tickets,Comisión Listero,Comisión Vendedor,Ganancia Listero');
    } else {
      lines.push('Fecha,Vendedor,Total Ventas,Total Tickets,Comisión Vendedor,Comisión Listero,Ganancia Neta');
    }

    // Datos
    for (const item of payload.summary) {
      const date = this.formatDate(item.date);
      
      // ✅ NUEVO: Detectar si hay agrupación (byVentana o byVendedor presente)
      const hasGrouping = (isDimensionVentana && item.byVentana && item.byVentana.length > 0) ||
                          (!isDimensionVentana && item.byVendedor && item.byVendedor.length > 0);

      if (hasGrouping) {
        // ✅ NUEVO: Fila de total consolidado con "TODOS"
        const totalEntity = 'TODOS';
        const totalSales = this.formatCurrency(item.totalSales);
        const totalTickets = item.totalTickets.toString();

        if (isDimensionVentana) {
          const commissionListero = this.formatCurrency(item.commissionListero || 0);
          const commissionVendedor = this.formatCurrency(item.commissionVendedor || 0);
          const gananciaListero = this.formatCurrency((item.commissionListero || 0) - (item.commissionVendedor || 0));

          lines.push(`${date},${this.escapeCsv(totalEntity)},${totalSales},${totalTickets},${commissionListero},${commissionVendedor},${gananciaListero}`);
        } else {
          const commissionVendedor = this.formatCurrency(item.commissionVendedor || 0);
          const commissionListero = this.formatCurrency(item.commissionListero || 0);
          const gananciaNeta = this.formatCurrency(item.net || 0);

          lines.push(`${date},${this.escapeCsv(totalEntity)},${totalSales},${totalTickets},${commissionVendedor},${commissionListero},${gananciaNeta}`);
        }

        // ✅ NUEVO: Filas de desglose por entidad con prefijo visual
        if (isDimensionVentana && item.byVentana) {
          for (const breakdown of item.byVentana) {
            const breakdownEntity = `  - ${breakdown.ventanaName}`;
            const breakdownSales = this.formatCurrency(breakdown.totalSales);
            const breakdownTickets = breakdown.totalTickets.toString();
            const breakdownCommissionListero = this.formatCurrency(breakdown.commissionListero || 0);
            const breakdownCommissionVendedor = this.formatCurrency(breakdown.commissionVendedor || 0);
            const breakdownGananciaListero = this.formatCurrency((breakdown.commissionListero || 0) - (breakdown.commissionVendedor || 0));

            lines.push(`${date},${this.escapeCsv(breakdownEntity)},${breakdownSales},${breakdownTickets},${breakdownCommissionListero},${breakdownCommissionVendedor},${breakdownGananciaListero}`);
          }
        } else if (!isDimensionVentana && item.byVendedor) {
          for (const breakdown of item.byVendedor) {
            const breakdownEntity = `  - ${breakdown.vendedorName}`;
            const breakdownSales = this.formatCurrency(breakdown.totalSales);
            const breakdownTickets = breakdown.totalTickets.toString();
            const breakdownCommissionVendedor = this.formatCurrency(breakdown.commissionVendedor || 0);
            const breakdownCommissionListero = this.formatCurrency(breakdown.commissionListero || 0);
            const breakdownGananciaNeta = this.formatCurrency(breakdown.net || 0);

            lines.push(`${date},${this.escapeCsv(breakdownEntity)},${breakdownSales},${breakdownTickets},${breakdownCommissionVendedor},${breakdownCommissionListero},${breakdownGananciaNeta}`);
          }
        }
      } else {
        // ✅ Comportamiento normal cuando NO hay agrupación
        const entity = isDimensionVentana ? item.ventanaName || '-' : item.vendedorName || '-';
        const totalSales = this.formatCurrency(item.totalSales);
        const totalTickets = item.totalTickets.toString();

        if (isDimensionVentana) {
          const commissionListero = this.formatCurrency(item.commissionListero || 0);
          const commissionVendedor = this.formatCurrency(item.commissionVendedor || 0);
          const gananciaListero = this.formatCurrency((item.commissionListero || 0) - (item.commissionVendedor || 0));

          lines.push(`${date},${this.escapeCsv(entity)},${totalSales},${totalTickets},${commissionListero},${commissionVendedor},${gananciaListero}`);
        } else {
          const commissionVendedor = this.formatCurrency(item.commissionVendedor || 0);
          const commissionListero = this.formatCurrency(item.commissionListero || 0);
          const gananciaNeta = this.formatCurrency(item.net || 0);

          lines.push(`${date},${this.escapeCsv(entity)},${totalSales},${totalTickets},${commissionVendedor},${commissionListero},${gananciaNeta}`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Genera sección de breakdown detallado
   */
  private static generateBreakdownSection(payload: CommissionExportPayload): string {
    const lines: string[] = [];
    const isDimensionVentana = payload.metadata.filters.dimension === 'ventana';

    lines.push('DESGLOSE POR LOTERÍA Y MULTIPLICADOR');
    lines.push(''); // Línea vacía

    // Encabezado
    if (isDimensionVentana) {
      lines.push('Fecha,Listero,Lotería,Sorteo,Multiplicador,Ventas,Comisión,% Comisión,Tickets');
    } else {
      lines.push('Fecha,Vendedor,Lotería,Sorteo,Multiplicador,Ventas,Comisión,% Comisión,Tickets');
    }

    // Datos
    for (const item of payload.breakdown || []) {
      const date = this.formatDate(item.date);
      const entity = isDimensionVentana ? (item.ventanaName || '-') : (item.vendedorName || '-');
      const loteria = this.escapeCsv(item.loteriaName);
      const sorteo = this.escapeCsv(item.sorteoTime);
      const multiplier = this.escapeCsv(item.multiplierName);
      const ventas = this.formatCurrency(item.totalSales);
      const comision = this.formatCurrency(item.commission);
      const percent = item.commissionPercent.toFixed(2) + '%';
      const tickets = item.ticketsCount.toString();

      lines.push(`${date},${this.escapeCsv(entity)},${loteria},${sorteo},${multiplier},${ventas},${comision},${percent},${tickets}`);
    }

    return lines.join('\n');
  }

  /**
   * Genera sección de advertencias
   */
  private static generateWarningsSection(payload: CommissionExportPayload): string {
    const lines: string[] = [];

    lines.push('ADVERTENCIAS');
    lines.push(''); // Línea vacía
    lines.push('Tipo,Descripción,Afecta a,Severidad');

    for (const warning of payload.warnings || []) {
      const type = this.escapeCsv(this.getWarningTypeLabel(warning.type));
      const description = this.escapeCsv(warning.description);
      const affected = this.escapeCsv(warning.affectedEntity);
      const severity = this.escapeCsv(warning.severity.toUpperCase());

      lines.push(`${type},${description},${affected},${severity}`);
    }

    return lines.join('\n');
  }

  /**
   * Genera sección de políticas de comisión
   */
  private static generatePoliciesSection(payload: CommissionExportPayload): string {
    const lines: string[] = [];
    const isDimensionVentana = payload.metadata.filters.dimension === 'ventana';

    lines.push('POLÍTICAS DE COMISIÓN CONFIGURADAS');
    lines.push(''); // Línea vacía

    // Encabezado
    const entityLabel = isDimensionVentana ? 'Listero' : 'Vendedor';
    lines.push(`${entityLabel},Lotería,Tipo de Apuesta,Rango Multiplicador,% Comisión`);

    // Datos
    for (const policy of payload.policies || []) {
      for (const rule of policy.rules) {
        const entityName = this.escapeCsv(policy.entityName);
        const loteriaName = this.escapeCsv(rule.loteriaName);
        const betType = this.escapeCsv(rule.betType);
        const multiplierRange = this.escapeCsv(rule.multiplierRange);
        const percent = rule.percent.toFixed(2) + '%';

        lines.push(`${entityName},${loteriaName},${betType},${multiplierRange},${percent}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Genera sección de totales
   */
  private static generateTotalsSection(payload: CommissionExportPayload): string {
    const lines: string[] = [];
    const isDimensionVentana = payload.metadata.filters.dimension === 'ventana';

    lines.push('TOTALES');

    if (isDimensionVentana) {
      lines.push(`Total Ventas,${this.formatCurrency(payload.metadata.totals.totalSales)}`);
      lines.push(`Total Tickets,${payload.metadata.totals.totalTickets}`);
      lines.push(`Total Comisión Listero,${this.formatCurrency(payload.metadata.totals.commissionListero || 0)}`);
      lines.push(`Total Comisión Vendedor,${this.formatCurrency(payload.metadata.totals.commissionVendedor || 0)}`);
      lines.push(`Total Ganancia Listero,${this.formatCurrency((payload.metadata.totals.commissionListero || 0) - (payload.metadata.totals.commissionVendedor || 0))}`);
    } else {
      lines.push(`Total Ventas,${this.formatCurrency(payload.metadata.totals.totalSales)}`);
      lines.push(`Total Tickets,${payload.metadata.totals.totalTickets}`);
      lines.push(`Total Comisión Vendedor,${this.formatCurrency(payload.metadata.totals.commissionVendedor || 0)}`);
      lines.push(`Total Comisión Listero,${this.formatCurrency(payload.metadata.totals.commissionListero || 0)}`);
      lines.push(`Total Ganancia Neta,${this.formatCurrency(payload.metadata.totals.net || 0)}`);
    }

    return lines.join('\n');
  }

  /**
   * Formatea fecha de YYYY-MM-DD a DD/MM/YYYY
   */
  private static formatDate(dateStr: string): string {
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

  /**
   * Formatea número como moneda (sin símbolo)
   */
  private static formatCurrency(value: number): string {
    // Asegurar que los números negativos muestren el símbolo -
    if (value < 0) {
      return `-${Math.abs(value).toFixed(2)}`;
    }
    return value.toFixed(2);
  }

  /**
   * Escapa valores para CSV (comillas si contiene coma, salto de línea o comillas)
   */
  private static escapeCsv(value: string): string {
    if (value.includes(',') || value.includes('\n') || value.includes('"')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  /**
   * Obtiene etiqueta legible del tipo de advertencia
   */
  private static getWarningTypeLabel(type: string): string {
    const labels: Record<string, string> = {
      missing_policy: 'Política Faltante',
      exclusion: 'Exclusión',
      inconsistency: 'Inconsistencia',
    };
    return labels[type] || type;
  }
}
