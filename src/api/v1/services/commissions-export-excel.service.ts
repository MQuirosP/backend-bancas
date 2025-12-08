// src/api/v1/services/commissions-export-excel.service.ts
import ExcelJS from 'exceljs';
import { CommissionExportPayload } from '../types/commissions-export.types';

/**
 * Servicio para exportar comisiones a Excel (.xlsx)
 */
export class CommissionsExportExcelService {
  /**
   * Genera workbook de Excel
   */
  static async generate(payload: CommissionExportPayload): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();

    workbook.creator = 'Sistema de Bancas';
    workbook.created = new Date();
    workbook.modified = new Date();

    // Hoja 1: Resumen
    this.addSummarySheet(workbook, payload);

    // Hoja 2: Breakdown (si está incluido)
    if (payload.breakdown && payload.breakdown.length > 0) {
      this.addBreakdownSheet(workbook, payload);
    }

    // Hoja 3: Advertencias (si están incluidas)
    if (payload.warnings && payload.warnings.length > 0) {
      this.addWarningsSheet(workbook, payload);
    }

    // Hoja 4: Políticas de comisión (si están incluidas)
    if (payload.policies && payload.policies.length > 0) {
      this.addPoliciesSheet(workbook, payload);
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  /**
   * Agrega hoja de resumen
   */
  private static addSummarySheet(workbook: ExcelJS.Workbook, payload: CommissionExportPayload): void {
    const sheet = workbook.addWorksheet('Comisiones');
    const isDimensionVentana = payload.metadata.filters.dimension === 'ventana';

    // Metadata del reporte (primeras filas)
    sheet.addRow(['Reporte de Comisiones']).font = { bold: true, size: 14 };
    sheet.addRow(['Generado:', this.formatDateTime(payload.metadata.generatedAt) + ' (GMT-6)']);
    sheet.addRow(['Período:', `${this.formatDate(payload.metadata.dateRange.from)} - ${this.formatDate(payload.metadata.dateRange.to)}`]);
    sheet.addRow(['Dimensión:', isDimensionVentana ? 'Listeros' : 'Vendedores']);

    if (payload.metadata.filters.ventanaName) {
      sheet.addRow(['Listero:', payload.metadata.filters.ventanaName]);
    }
    if (payload.metadata.filters.vendedorName) {
      sheet.addRow(['Vendedor:', payload.metadata.filters.vendedorName]);
    }

    sheet.addRow([]); // Fila vacía

    // Encabezados de tabla
    const headerRow = isDimensionVentana
      ? sheet.addRow(['Fecha', 'Listero', 'Total Ventas', 'Total Tickets', 'Comisión Listero', 'Comisión Vendedor', 'Ganancia Listero'])
      : sheet.addRow(['Fecha', 'Vendedor', 'Total Ventas', 'Total Tickets', 'Comisión Vendedor', 'Comisión Listero', 'Ganancia Neta']);

    this.styleHeaderRow(headerRow);

    // Datos
    for (const item of payload.summary) {
      const date = this.formatDate(item.date);
      
      // ✅ NUEVO: Detectar si hay agrupación (byVentana o byVendedor presente)
      const hasGrouping = (isDimensionVentana && item.byVentana && item.byVentana.length > 0) ||
                          (!isDimensionVentana && item.byVendedor && item.byVendedor.length > 0);

      if (hasGrouping) {
        // ✅ NUEVO: Fila de total consolidado con "TODOS" y formato destacado
        const totalEntity = 'TODOS';
        
        const totalRow = isDimensionVentana
          ? sheet.addRow([
              date,
              totalEntity,
              item.totalSales,
              item.totalTickets,
              item.commissionListero || 0,
              item.commissionVendedor || 0,
              (item.commissionListero || 0) - (item.commissionVendedor || 0),
            ])
          : sheet.addRow([
              date,
              totalEntity,
              item.totalSales,
              item.totalTickets,
              item.commissionVendedor || 0,
              item.commissionListero || 0,
              item.net || 0,
            ]);

        // ✅ NUEVO: Formato destacado para fila de total (negrita, fondo gris claro)
        this.styleTotalRow(totalRow);

        // ✅ NUEVO: Filas de desglose por entidad con indentación visual
        if (isDimensionVentana && item.byVentana) {
          for (const breakdown of item.byVentana) {
            const breakdownEntity = `  - ${breakdown.ventanaName}`;
            const breakdownRow = sheet.addRow([
              date,
              breakdownEntity,
              breakdown.totalSales,
              breakdown.totalTickets,
              breakdown.commissionListero || 0,
              breakdown.commissionVendedor || 0,
              (breakdown.commissionListero || 0) - (breakdown.commissionVendedor || 0),
            ]);
            this.styleDataRow(breakdownRow);
          }
        } else if (!isDimensionVentana && item.byVendedor) {
          for (const breakdown of item.byVendedor) {
            const breakdownEntity = `  - ${breakdown.vendedorName}`;
            const breakdownRow = sheet.addRow([
              date,
              breakdownEntity,
              breakdown.totalSales,
              breakdown.totalTickets,
              breakdown.commissionVendedor || 0,
              breakdown.commissionListero || 0,
              breakdown.net || 0,
            ]);
            this.styleDataRow(breakdownRow);
          }
        }
      } else {
        // ✅ Comportamiento normal cuando NO hay agrupación
        const entity = isDimensionVentana ? item.ventanaName || '-' : item.vendedorName || '-';

        const row = isDimensionVentana
          ? sheet.addRow([
              date,
              entity,
              item.totalSales,
              item.totalTickets,
              item.commissionListero || 0,
              item.commissionVendedor || 0,
              (item.commissionListero || 0) - (item.commissionVendedor || 0),
            ])
          : sheet.addRow([
              date,
              entity,
              item.totalSales,
              item.totalTickets,
              item.commissionVendedor || 0,
              item.commissionListero || 0,
              item.net || 0,
            ]);

        this.styleDataRow(row);
      }
    }

    // Fila de totales
    const totalRow = isDimensionVentana
      ? sheet.addRow([
          'TOTAL',
          '-',
          payload.metadata.totals.totalSales,
          payload.metadata.totals.totalTickets,
          payload.metadata.totals.commissionListero || 0,
          payload.metadata.totals.commissionVendedor || 0,
          (payload.metadata.totals.commissionListero || 0) - (payload.metadata.totals.commissionVendedor || 0),
        ])
      : sheet.addRow([
          'TOTAL',
          '-',
          payload.metadata.totals.totalSales,
          payload.metadata.totals.totalTickets,
          payload.metadata.totals.commissionVendedor || 0,
          payload.metadata.totals.commissionListero || 0,
          payload.metadata.totals.net || 0,
        ]);

    this.styleTotalRow(totalRow);

    // Ajustar anchos de columna
    this.autoSizeColumns(sheet);

    // Congelar encabezado
    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: headerRow.number }];
  }

  /**
   * Agrega hoja de breakdown detallado
   */
  private static addBreakdownSheet(workbook: ExcelJS.Workbook, payload: CommissionExportPayload): void {
    const sheet = workbook.addWorksheet('Desglose por Lotería');
    const isDimensionVentana = payload.metadata.filters.dimension === 'ventana';

    // Título
    sheet.addRow(['Desglose por Lotería, Sorteo y Multiplicador']).font = { bold: true, size: 14 };
    sheet.addRow([]); // Fila vacía

    // Encabezados
    const headerRow = isDimensionVentana
      ? sheet.addRow(['Fecha', 'Listero', 'Lotería', 'Sorteo', 'Multiplicador', 'Ventas', 'Comisión', '% Comisión', 'Tickets'])
      : sheet.addRow(['Fecha', 'Vendedor', 'Lotería', 'Sorteo', 'Multiplicador', 'Ventas', 'Comisión', '% Comisión', 'Tickets']);

    this.styleHeaderRow(headerRow);

    // Datos
    for (const item of payload.breakdown || []) {
      const date = this.formatDate(item.date);
      const entity = isDimensionVentana ? (item.ventanaName || '-') : (item.vendedorName || '-');

      const row = sheet.addRow([
        date,
        entity,
        item.loteriaName,
        item.sorteoTime,
        item.multiplierName,
        item.totalSales,
        item.commission,
        item.commissionPercent / 100, // Excel formateará como porcentaje
        item.ticketsCount,
      ]);

      this.styleDataRow(row);

      // Formato especial para porcentaje
      row.getCell(8).numFmt = '0.00%';
    }

    // Ajustar anchos de columna
    this.autoSizeColumns(sheet);

    // Congelar encabezado
    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: headerRow.number }];
  }

  /**
   * Agrega hoja de advertencias
   */
  private static addWarningsSheet(workbook: ExcelJS.Workbook, payload: CommissionExportPayload): void {
    const sheet = workbook.addWorksheet('Advertencias');

    // Título
    sheet.addRow(['Advertencias y Notas']).font = { bold: true, size: 14 };
    sheet.addRow([]); // Fila vacía

    // Encabezados
    const headerRow = sheet.addRow(['Tipo', 'Descripción', 'Afecta a', 'Severidad']);
    this.styleHeaderRow(headerRow);

    // Datos
    for (const warning of payload.warnings || []) {
      const row = sheet.addRow([
        this.getWarningTypeLabel(warning.type),
        warning.description,
        warning.affectedEntity,
        warning.severity.toUpperCase(),
      ]);

      // Color según severidad
      if (warning.severity === 'high') {
        row.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFCCCC' }, // Rojo claro
        };
      } else if (warning.severity === 'medium') {
        row.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFEDCC' }, // Naranja claro
        };
      } else {
        row.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFE699' }, // Amarillo claro
        };
      }
    }

    // Ajustar anchos de columna
    this.autoSizeColumns(sheet);

    // Congelar encabezado
    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: headerRow.number }];
  }

  /**
   * Agrega hoja de políticas de comisión
   */
  private static addPoliciesSheet(workbook: ExcelJS.Workbook, payload: CommissionExportPayload): void {
    const sheet = workbook.addWorksheet('Políticas de Comisión');
    const isDimensionVentana = payload.metadata.filters.dimension === 'ventana';

    // Título
    sheet.addRow(['Políticas de Comisión Configuradas']).font = { bold: true, size: 14 };
    sheet.addRow(['Dimensión:', isDimensionVentana ? 'Listeros' : 'Vendedores']);
    sheet.addRow([]); // Fila vacía

    // Encabezados
    const headerRow = sheet.addRow([
      isDimensionVentana ? 'Listero' : 'Vendedor',
      'Lotería',
      'Tipo de Apuesta',
      'Rango Multiplicador',
      '% Comisión',
    ]);

    this.styleHeaderRow(headerRow);

    // Datos
    for (const policy of payload.policies || []) {
      for (const rule of policy.rules) {
        const row = sheet.addRow([
          policy.entityName,
          rule.loteriaName,
          rule.betType,
          rule.multiplierRange,
          rule.percent / 100, // Excel formateará como porcentaje
        ]);

        // Formato especial para porcentaje
        row.getCell(5).numFmt = '0.00%';
        row.alignment = { horizontal: 'left', vertical: 'middle' };
      }
    }

    // Ajustar anchos de columna
    this.autoSizeColumns(sheet);

    // Congelar encabezado
    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: headerRow.number }];
  }

  /**
   * Aplica estilos a la fila de encabezado
   */
  private static styleHeaderRow(row: ExcelJS.Row): void {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }, // Azul
    };
    row.alignment = { horizontal: 'center', vertical: 'middle' };
    row.height = 20;
  }

  /**
   * Aplica estilos a filas de datos
   */
  private static styleDataRow(row: ExcelJS.Row): void {
    row.alignment = { horizontal: 'left', vertical: 'middle' };

    // Formato de moneda para columnas monetarias (a partir de columna 3)
    for (let i = 3; i <= row.cellCount; i++) {
      const cell = row.getCell(i);
      if (typeof cell.value === 'number') {
        // Detectar si es moneda o contador
        if (i === 3 || i === 5 || i === 6 || i === 7) {
          // Columnas monetarias
          cell.numFmt = '₡#,##0.00';
        } else if (i === 4) {
          // Total Tickets (entero)
          cell.numFmt = '#,##0';
        }
      }
    }
  }

  /**
   * Aplica estilos a la fila de total
   */
  private static styleTotalRow(row: ExcelJS.Row): void {
    row.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
    row.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF203764' }, // Azul oscuro
    };
    row.alignment = { horizontal: 'left', vertical: 'middle' };
    row.height = 22;

    // Formato de moneda
    for (let i = 3; i <= row.cellCount; i++) {
      const cell = row.getCell(i);
      if (typeof cell.value === 'number') {
        if (i === 3 || i === 5 || i === 6 || i === 7) {
          cell.numFmt = '₡#,##0.00';
        } else if (i === 4) {
          cell.numFmt = '#,##0';
        }
      }
    }
  }

  /**
   * Ajusta automáticamente el ancho de las columnas
   */
  private static autoSizeColumns(sheet: ExcelJS.Worksheet): void {
    sheet.columns.forEach((column) => {
      let maxLength = 10; // Mínimo

      if (column && column.eachCell) {
        column.eachCell({ includeEmpty: false }, (cell) => {
          const cellValue = cell.value ? cell.value.toString() : '';
          maxLength = Math.max(maxLength, cellValue.length);
        });
      }

      if (column) {
        column.width = Math.min(maxLength + 2, 50); // Máximo 50
      }
    });
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
