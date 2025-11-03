import ExcelJS from 'exceljs';
import {
  CierreWeeklyData,
  CierreBySellerData,
  CierreView,
  BandaMetrics,
  LoteriaMetrics,
  CeldaMetrics,
  TurnoMetrics,
  VendedorMetrics,
  LoteriaType,
} from '../types/cierre.types';

/**
 * Servicio para exportar cierres a Excel (.xlsx)
 * Genera hojas que replican el formato del Excel de referencia
 */
export class CierreExportService {
  /**
   * Genera un workbook de Excel basado en la vista especificada
   */
  static async generateWorkbook(
    data: CierreWeeklyData | CierreBySellerData,
    view: CierreView
  ): Promise<ExcelJS.Workbook> {
    const workbook = new ExcelJS.Workbook();

    workbook.creator = 'Sistema de Bancas';
    workbook.created = new Date();
    workbook.modified = new Date();

    if (view === 'seller') {
      // Vista por vendedor
      const sellerData = data as CierreBySellerData;
      this.addSellerSheet(workbook, sellerData);
    } else if (view === 'total') {
      // Vista total: todas las bandas en una hoja
      const weeklyData = data as CierreWeeklyData;
      this.addTotalSheet(workbook, weeklyData);
    } else {
      // Vista por banda específica (80, 85, 90, 92, 200)
      const weeklyData = data as CierreWeeklyData;
      const banda = parseInt(view as string, 10);
      this.addBandSheet(workbook, weeklyData, banda);
    }

    return workbook;
  }

  /**
   * Agrega hoja con resumen total de todas las bandas
   */
  private static addTotalSheet(
    workbook: ExcelJS.Workbook,
    data: CierreWeeklyData
  ): void {
    const sheet = workbook.addWorksheet('Cierre Total');

    this.styleSheetHeader(sheet);

    // Encabezado
    const headerRow = sheet.addRow([
      'Banda',
      'Lotería',
      'Turno',
      'Total Vendida',
      'Ganado',
      'Comisión',
      'Neto Después Comisión',
      'Refuerzos',
      'Tickets',
      'Jugadas',
    ]);

    this.styleHeaderRow(headerRow);

    // Datos por banda
    const bandaKeys = Object.keys(data.bands)
      .map((k) => Number(k))
      .sort((a, b) => a - b);

    for (const banda of bandaKeys) {
      const bandaData = data.bands[String(banda)];

      if (bandaData) {
        this.addBandDataRows(sheet, banda, bandaData);

        // Fila de total por banda
        const totalRow = sheet.addRow([
          `TOTAL BANDA ${banda}`,
          '',
          '',
          bandaData.total.totalVendida,
          bandaData.total.ganado,
          bandaData.total.comisionTotal,
          bandaData.total.netoDespuesComision,
          bandaData.total.refuerzos,
          bandaData.total.ticketsCount,
          bandaData.total.jugadasCount,
        ]);

        this.styleTotalRow(totalRow);
      }
    }

    // Fila final: totales globales
    const finalRow = sheet.addRow([
      'TOTAL GLOBAL',
      '',
      '',
      data.totals.totalVendida,
      data.totals.ganado,
      data.totals.comisionTotal,
      data.totals.netoDespuesComision,
      data.totals.refuerzos,
      data.totals.ticketsCount,
      data.totals.jugadasCount,
    ]);

    this.styleGrandTotalRow(finalRow);

    // Ajustar anchos de columna
    this.autoSizeColumns(sheet);
  }

  /**
   * Agrega hoja para una banda específica
   */
  private static addBandSheet(
    workbook: ExcelJS.Workbook,
    data: CierreWeeklyData,
    banda: number
  ): void {
    const bandaData = data.bands[String(banda)];

    if (!bandaData) {
      // Banda sin datos
      const sheet = workbook.addWorksheet(`Banda ${banda}`);
      sheet.addRow([`No hay datos para banda ${banda}`]);
      return;
    }

    const sheet = workbook.addWorksheet(`Banda ${banda}`);

    this.styleSheetHeader(sheet);

    // Encabezado
    const headerRow = sheet.addRow([
      'Lotería',
      'Turno',
      'Total Vendida',
      'Ganado',
      'Comisión',
      'Neto Después Comisión',
      'Refuerzos',
      'Tickets',
      'Jugadas',
    ]);

    this.styleHeaderRow(headerRow);

    // Datos por lotería
    this.addBandDataRows(sheet, banda, bandaData);

    // Fila de total
    const totalRow = sheet.addRow([
      'TOTAL',
      '',
      bandaData.total.totalVendida,
      bandaData.total.ganado,
      bandaData.total.comisionTotal,
      bandaData.total.netoDespuesComision,
      bandaData.total.refuerzos,
      bandaData.total.ticketsCount,
      bandaData.total.jugadasCount,
    ]);

    this.styleGrandTotalRow(totalRow);

    this.autoSizeColumns(sheet);
  }

  /**
   * Agrega hoja por vendedor
   */
  private static addSellerSheet(
    workbook: ExcelJS.Workbook,
    data: CierreBySellerData
  ): void {
    const sheet = workbook.addWorksheet('Cierre por Vendedor');

    this.styleSheetHeader(sheet);

    // Encabezado
    const headerRow = sheet.addRow([
      'Vendedor',
      'Ventana',
      'Total Vendida',
      'Ganado',
      'Comisión',
      'Neto Después Comisión',
      'Refuerzos',
      'Tickets',
      'Jugadas',
    ]);

    this.styleHeaderRow(headerRow);

    // Datos por vendedor
    for (const vendedor of data.vendedores) {
      const row = sheet.addRow([
        vendedor.vendedorNombre,
        vendedor.ventanaNombre,
        vendedor.totalVendida,
        vendedor.ganado,
        vendedor.comisionTotal,
        vendedor.netoDespuesComision,
        vendedor.refuerzos,
        vendedor.ticketsCount,
        vendedor.jugadasCount,
      ]);

      this.styleDataRow(row);
    }

    // Fila de total
    const totalRow = sheet.addRow([
      'TOTAL',
      '',
      data.totals.totalVendida,
      data.totals.ganado,
      data.totals.comisionTotal,
      data.totals.netoDespuesComision,
      data.totals.refuerzos,
      data.totals.ticketsCount,
      data.totals.jugadasCount,
    ]);

    this.styleGrandTotalRow(totalRow);

    this.autoSizeColumns(sheet);
  }

  /**
   * Agrega filas de datos para una banda (por lotería y turno)
   */
  private static addBandDataRows(
    sheet: ExcelJS.Worksheet,
    banda: number,
    bandaData: BandaMetrics
  ): void {
    const loteriaNames = Object.keys(bandaData.loterias);

    for (const loteriaName of loteriaNames) {
      const loteriaData = bandaData.loterias[loteriaName as LoteriaType];

      const turnos = Object.keys(loteriaData.turnos).sort();

      for (const turno of turnos) {
        const turnoData = loteriaData.turnos[turno];

        const row = sheet.addRow([
          banda,
          loteriaName,
          turno,
          turnoData.totalVendida,
          turnoData.ganado,
          turnoData.comisionTotal,
          turnoData.netoDespuesComision,
          turnoData.refuerzos,
          turnoData.ticketsCount,
          turnoData.jugadasCount,
        ]);

        this.styleDataRow(row);
      }

      // Subtotal por lotería
      const subtotalRow = sheet.addRow([
        banda,
        `SUBTOTAL ${loteriaName}`,
        '',
        loteriaData.subtotal.totalVendida,
        loteriaData.subtotal.ganado,
        loteriaData.subtotal.comisionTotal,
        loteriaData.subtotal.netoDespuesComision,
        loteriaData.subtotal.refuerzos,
        loteriaData.subtotal.ticketsCount,
        loteriaData.subtotal.jugadasCount,
      ]);

      this.styleSubtotalRow(subtotalRow);
    }
  }

  /**
   * Aplica estilos al encabezado de la hoja
   */
  private static styleSheetHeader(sheet: ExcelJS.Worksheet): void {
    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }]; // Congelar encabezado
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

    // Formato de moneda para columnas numéricas (columnas 3-9)
    for (let i = 4; i <= 10; i++) {
      const cell = row.getCell(i);
      if (typeof cell.value === 'number') {
        if (i <= 7) {
          // Columnas monetarias
          cell.numFmt = '₡#,##0.00';
        } else {
          // Contadores
          cell.numFmt = '#,##0';
        }
      }
    }
  }

  /**
   * Aplica estilos a filas de subtotal
   */
  private static styleSubtotalRow(row: ExcelJS.Row): void {
    row.font = { bold: true };
    row.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE7E6E6' }, // Gris claro
    };
    row.alignment = { horizontal: 'left', vertical: 'middle' };

    // Formato de moneda
    for (let i = 4; i <= 10; i++) {
      const cell = row.getCell(i);
      if (typeof cell.value === 'number') {
        if (i <= 7) {
          cell.numFmt = '₡#,##0.00';
        } else {
          cell.numFmt = '#,##0';
        }
      }
    }
  }

  /**
   * Aplica estilos a filas de total por banda
   */
  private static styleTotalRow(row: ExcelJS.Row): void {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF70AD47' }, // Verde
    };
    row.alignment = { horizontal: 'left', vertical: 'middle' };

    for (let i = 4; i <= 10; i++) {
      const cell = row.getCell(i);
      if (typeof cell.value === 'number') {
        if (i <= 7) {
          cell.numFmt = '₡#,##0.00';
        } else {
          cell.numFmt = '#,##0';
        }
      }
    }
  }

  /**
   * Aplica estilos a la fila de total global
   */
  private static styleGrandTotalRow(row: ExcelJS.Row): void {
    row.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
    row.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF203764' }, // Azul oscuro
    };
    row.alignment = { horizontal: 'left', vertical: 'middle' };
    row.height = 22;

    for (let i = 4; i <= 10; i++) {
      const cell = row.getCell(i);
      if (typeof cell.value === 'number') {
        if (i <= 7) {
          cell.numFmt = '₡#,##0.00';
        } else {
          cell.numFmt = '#,##0';
        }
      }
    }
  }

  /**
   * Ajusta automáticamente el ancho de las columnas
   */
  private static autoSizeColumns(sheet: ExcelJS.Worksheet): void {
    sheet.columns.forEach((column, index) => {
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
}
