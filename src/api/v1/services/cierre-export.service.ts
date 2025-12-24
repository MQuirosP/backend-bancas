import ExcelJS from 'exceljs';
import {
  CierreWeeklyData,
  CierreBySellerData,
  CierreView,
  LoteriaMetrics,
  CeldaMetrics,
  TurnoAgrupado,
  VendedorMetrics,
  LoteriaType,
} from '../types/cierre.types';

/**
 * Servicio para exportar cierres a Excel (.xlsx)
 * Genera automáticamente todas las pestañas necesarias
 */
export class CierreExportService {
  /**
   * Genera un workbook de Excel con todas las pestañas
   * - Una pestaña por cada banda presente
   * - Una pestaña "Cierre Total" consolidada
   * - Si es vista por vendedor, genera solo esa pestaña
   */
  static async generateWorkbook(
    data: CierreWeeklyData | CierreBySellerData,
    view: CierreView
  ): Promise<ExcelJS.Workbook> {
    const workbook = new ExcelJS.Workbook();

    workbook.creator = 'Sistema de Bancas';
    workbook.created = new Date();
    workbook.modified = new Date();

    // Si es vista por vendedor, solo generar esa pestaña
    if (view === 'seller') {
      const sellerData = data as CierreBySellerData;
      this.addSellerSheet(workbook, sellerData);
      return workbook;
    }

    // Para vistas weekly: generar todas las pestañas automáticamente
    const weeklyData = data as CierreWeeklyData;

    // Detectar bandas presentes en los datos
    const bandasPresentes = Object.keys(weeklyData.bands)
      .map((k) => Number(k))
      .sort((a, b) => a - b);

    // Crear una pestaña por cada banda presente
    for (const banda of bandasPresentes) {
      this.addBandSheet(workbook, weeklyData, banda);
    }

    // Crear pestaña "Cierre Total" al final
    this.addTotalSheet(workbook, weeklyData);

    return workbook;
  }

  /**
   * Agrega hoja con resumen total consolidado de todas las bandas
   * Muestra solo totales por banda y total general (sin detalle operativo)
   */
  private static addTotalSheet(
    workbook: ExcelJS.Workbook,
    data: CierreWeeklyData
  ): void {
    const sheet = workbook.addWorksheet('Cierre Total');

    this.styleSheetHeader(sheet);

    // Encabezado simplificado (solo totales, sin detalle de turnos)
    const headerRow = sheet.addRow([
      'Banda',
      'Total Vendido',
      'Premios',
      'Comisión',
      'Neto Después Comisión',
    ]);

    this.styleHeaderRow(headerRow);

    // Ordenar bandas
    const bandaKeys = Object.keys(data.bands)
      .map((k) => Number(k))
      .sort((a, b) => a - b);

    // Agregar fila por cada banda con sus totales
    for (const banda of bandaKeys) {
      const bandaData = data.bands[String(banda)];

      if (bandaData) {
        const row = sheet.addRow([
          `Banda ${banda}`,
          bandaData.total.totalVendida,
          bandaData.total.ganado,
          bandaData.total.comisionTotal,
          bandaData.total.netoDespuesComision,
        ]);

        this.styleTotalRow(row);
      }
    }

    // Fila final: totales globales
    const finalRow = sheet.addRow([
      'TOTAL GLOBAL',
      data.totals.totalVendida,
      data.totals.ganado,
      data.totals.comisionTotal,
      data.totals.netoDespuesComision,
    ]);

    this.styleGrandTotalRow(finalRow);

    // Ajustar anchos de columna
    this.autoSizeColumns(sheet);
  }

  /**
   * Agrega hoja para una banda específica
   * Jerarquía: Día → Lotería → Turno
   */
  private static addBandSheet(
    workbook: ExcelJS.Workbook,
    data: CierreWeeklyData,
    banda: number
  ): void {
    const bandaData = data.bands[String(banda)];

    if (!bandaData) {
      // Banda sin datos (no debería ocurrir porque solo creamos pestañas para bandas presentes)
      const sheet = workbook.addWorksheet(`Banda ${banda}`);
      sheet.addRow([`No hay datos para banda ${banda}`]);
      return;
    }

    const sheet = workbook.addWorksheet(`Banda ${banda}`);
    this.styleSheetHeader(sheet);

    // Encabezado
    const headerRow = sheet.addRow([
      'Fecha',
      'Lotería',
      'Turno',
      'Tipo',
      'Total Vendido',
      'Premios',
      'Comisión',
      'Neto Después Comisión',
    ]);

    this.styleHeaderRow(headerRow);

    // Ordenar días cronológicamente
    const fechas = Object.keys(bandaData.dias).sort();
    const esMultiDia = fechas.length > 1;

    // Iterar por cada día
    for (const fecha of fechas) {
      const diaData = bandaData.dias[fecha];

      // Iterar por cada lotería del día
      const loterias = Object.keys(diaData.loterias) as LoteriaType[];

      for (const loteria of loterias) {
        const loteriaData = diaData.loterias[loteria];
        const turnos = Object.keys(loteriaData.turnos).sort();

        // Iterar por cada turno (ahora agrupado)
        for (const turnoKey of turnos) {
          const turnoAgrupado = loteriaData.turnos[turnoKey];

          // Agregar fila para NUMERO si existe
          if (turnoAgrupado.NUMERO) {
            const row = sheet.addRow([
              fecha,
              loteria,
              turnoAgrupado.turno,
              'NUMERO',
              turnoAgrupado.NUMERO.totalVendida,
              turnoAgrupado.NUMERO.ganado,
              turnoAgrupado.NUMERO.comisionTotal,
              turnoAgrupado.NUMERO.netoDespuesComision,
            ]);
            this.styleDataRow(row);
          }

          // Agregar fila para REVENTADO si existe
          if (turnoAgrupado.REVENTADO) {
            const row = sheet.addRow([
              fecha,
              loteria,
              turnoAgrupado.turno,
              'REVENTADO',
              turnoAgrupado.REVENTADO.totalVendida,
              turnoAgrupado.REVENTADO.ganado,
              turnoAgrupado.REVENTADO.comisionTotal,
              turnoAgrupado.REVENTADO.netoDespuesComision,
            ]);
            this.styleDataRow(row);
          }
        }

        // Subtotal por lotería
        const subtotalRow = sheet.addRow([
          fecha,
          `SUBTOTAL ${loteria}`,
          '',
          '',
          loteriaData.subtotal.totalVendida,
          loteriaData.subtotal.ganado,
          loteriaData.subtotal.comisionTotal,
          loteriaData.subtotal.netoDespuesComision,
        ]);

        this.styleSubtotalRow(subtotalRow);
      }

      // Total por día (solo si es multi-día)
      if (esMultiDia) {
        const totalDiaRow = sheet.addRow([
          `TOTAL ${fecha}`,
          '',
          '',
          '',
          diaData.totalDia.totalVendida,
          diaData.totalDia.ganado,
          diaData.totalDia.comisionTotal,
          diaData.totalDia.netoDespuesComision,
        ]);

        this.styleTotalRow(totalDiaRow);
      }
    }

    // Total final de la banda
    const totalBandaRow = sheet.addRow([
      'TOTAL BANDA',
      '',
      '',
      '',
      bandaData.total.totalVendida,
      bandaData.total.ganado,
      bandaData.total.comisionTotal,
      bandaData.total.netoDespuesComision,
    ]);

    this.styleGrandTotalRow(totalBandaRow);

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
      'Total Vendido',
      'Premios',
      'Comisión',
      'Neto Después Comisión',
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
    ]);

    this.styleGrandTotalRow(totalRow);

    this.autoSizeColumns(sheet);
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

    // Formato de moneda para columnas numéricas (columnas 5-8)
    // Columnas: Fecha, Lotería, Turno, Tipo, [Total Vendido, Premios, Comisión, Neto]
    for (let i = 5; i <= 8; i++) {
      const cell = row.getCell(i);
      if (typeof cell.value === 'number') {
        // Todas las columnas numéricas son monetarias
        // Formato: positivos con ₡, negativos con -₡
        cell.numFmt = '₡#,##0.00;-₡#,##0.00';
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

    // Aplicar formato a todas las celdas numéricas
    this.applyNumericFormats(row);
  }

  /**
   * Aplica estilos a filas de total por día o total por banda
   */
  private static styleTotalRow(row: ExcelJS.Row): void {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF70AD47' }, // Verde
    };
    row.alignment = { horizontal: 'left', vertical: 'middle' };

    // Aplicar formato a todas las celdas numéricas
    this.applyNumericFormats(row);
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

    // Aplicar formato a todas las celdas numéricas
    this.applyNumericFormats(row);
  }

  /**
   * Aplica formatos numéricos a una fila
   * Todas las columnas numéricas son monetarias
   */
  private static applyNumericFormats(row: ExcelJS.Row): void {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (typeof cell.value === 'number') {
        // Todas las columnas numéricas son monetarias
        // Formato: positivos con ₡, negativos con -₡
        cell.numFmt = '₡#,##0.00;-₡#,##0.00';
      }
    });
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
