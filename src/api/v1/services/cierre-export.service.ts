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
  CierreLoteriaGroup,
  CierreSorteoGroup,
  CierreBandData,
} from '../types/cierre.types';
import { crDateService } from '../../../utils/crDateService';

/**
 * Servicio para exportar cierres a Excel (.xlsx)
 * Genera automáticamente todas las pestañas necesarias
 */
export class CierreExportService {
  /**
   * Genera un workbook de Excel con todas las pestañas
   * - Una pestaña por cada banda presente
   * - Una pestaña "Cierre Total" consolidada
   * - Una pestaña "Cierre por Vendedor" (si sellerData está disponible)
   * - Si es vista por vendedor, genera solo esa pestaña
   * @param isExtendedPeriod Si es true, incluye fechas en los sorteos (periodo > 1 día)
   * @param sellerData Datos por vendedor para incluir como pestaña adicional (opcional)
   */
  static async generateWorkbook(
    data: CierreWeeklyData | CierreBySellerData,
    view: CierreView,
    isExtendedPeriod: boolean = false,
    sellerData?: CierreBySellerData | null
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

    // ✅ NUEVO: Detectar bandas presentes en los datos (extraer de la nueva estructura)
    const bandasPresentes = this.extractBandsFromLoterias(weeklyData.loterias)
      .sort((a, b) => a - b);

    // Crear una pestaña por cada banda presente
    for (const banda of bandasPresentes) {
      this.addBandSheet(workbook, weeklyData, banda, isExtendedPeriod);
    }

    // Crear pestaña "Cierre Total" al final
    this.addTotalSheet(workbook, weeklyData);

    // ✅ NUEVO: Agregar pestaña por vendedor si está disponible
    if (sellerData) {
      this.addSellerSheet(workbook, sellerData);
    }

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

    // ✅ NUEVO: Calcular totales por banda desde la nueva estructura
    const totalsByBanda = this.calculateTotalsByBanda(data.loterias);
    const bandaKeys = Array.from(totalsByBanda.keys())
      .sort((a, b) => a - b);

    // Agregar fila por cada banda con sus totales
    for (const banda of bandaKeys) {
      const bandaTotals = totalsByBanda.get(banda)!;

      const row = sheet.addRow([
        `Banda ${banda}`,
        bandaTotals.totalVendida,
        bandaTotals.ganado,
        bandaTotals.comisionTotal,
        bandaTotals.netoDespuesComision,
      ]);

      this.styleTotalRow(row);
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
   * ✅ NUEVO: Jerarquía: Lotería → Sorteo → Tipo (NUMERO/REVENTADO)
   * @param isExtendedPeriod Si es true, incluye fechas en los sorteos
   */
  private static addBandSheet(
    workbook: ExcelJS.Workbook,
    data: CierreWeeklyData,
    banda: number,
    isExtendedPeriod: boolean = false
  ): void {
    const sheet = workbook.addWorksheet(`Banda ${banda}`);
    this.styleSheetHeader(sheet);

    // Encabezado
    const headerRow = sheet.addRow([
      'Lotería',
      'Sorteo (Turno)',
      'Total Vendido',
      'Premios',
      'Comisión',
      'Neto Después Comisión',
    ]);

    this.styleHeaderRow(headerRow);

    let bandaTotal = this.createEmptyMetrics();

    // Iterar por cada lotería
    for (const loteriaGroup of data.loterias) {
      let loteriaSubtotal = this.createEmptyMetrics();

      // Iterar por cada sorteo de la lotería (ya separado por tipo en la vista)
      for (const sorteoGroup of loteriaGroup.sorteos) {
        const bandaData = sorteoGroup.bands[String(banda)];
        if (!bandaData) continue;

        // Formatear turno (con fecha si es periodo extendido). sorteo.turno ya incluye 'Numero' o 'Reventado'
        let turnoDisplay = sorteoGroup.sorteo.turno;
        if (isExtendedPeriod && sorteoGroup.sorteo.scheduledAt) {
          const sorteoDate = new Date(sorteoGroup.sorteo.scheduledAt);
          const dateStr = crDateService.dateUTCToCRString(sorteoDate);
          turnoDisplay = `${dateStr} ${turnoDisplay}`;
        }

        const row = sheet.addRow([
          loteriaGroup.loteria.name,
          turnoDisplay,
          bandaData.totalVendida,
          bandaData.ganado,
          bandaData.comisionTotal,
          bandaData.netoDespuesComision,
        ]);
        this.styleDataRow(row);
        this.accumulateMetrics(loteriaSubtotal, {
          totalVendida: bandaData.totalVendida,
          ganado: bandaData.ganado,
          comisionTotal: bandaData.comisionTotal,
          netoDespuesComision: bandaData.netoDespuesComision,
          refuerzos: bandaData.refuerzos || 0,
          ticketsCount: bandaData.ticketsCount,
          jugadasCount: 0,
        });
      }

      // Subtotal por lotería (si hay datos)
      if (loteriaSubtotal.totalVendida > 0) {
        const subtotalRow = sheet.addRow([
          `SUBTOTAL ${loteriaGroup.loteria.name}`,
          '',
          loteriaSubtotal.totalVendida,
          loteriaSubtotal.ganado,
          loteriaSubtotal.comisionTotal,
          loteriaSubtotal.netoDespuesComision,
        ]);
        this.styleSubtotalRow(subtotalRow);
        this.accumulateMetrics(bandaTotal, loteriaSubtotal);
      }
    }

    // Total final de la banda
    if (bandaTotal.totalVendida > 0) {
      const totalBandaRow = sheet.addRow([
        'TOTAL BANDA',
        '',
        bandaTotal.totalVendida,
        bandaTotal.ganado,
        bandaTotal.comisionTotal,
        bandaTotal.netoDespuesComision,
      ]);
      this.styleGrandTotalRow(totalBandaRow);
    } else {
      sheet.addRow([`No hay datos para banda ${banda}`]);
    }

    this.autoSizeColumns(sheet);
  }

  /**
   * ✅ Helper: Extrae todas las bandas únicas de la estructura de loterías
   */
  private static extractBandsFromLoterias(loterias: CierreLoteriaGroup[]): number[] {
    const bandsSet = new Set<number>();

    for (const loteriaGroup of loterias) {
      for (const sorteoGroup of loteriaGroup.sorteos) {
        // ✅ NUEVO: Extraer bandas directamente (ya sumadas NUMERO + REVENTADO)
        for (const bandaKey of Object.keys(sorteoGroup.bands)) {
          bandsSet.add(Number(bandaKey));
        }
      }
    }

    return Array.from(bandsSet);
  }

  /**
   * ✅ Helper: Calcula totales por banda desde la estructura de loterías
   */
  private static calculateTotalsByBanda(loterias: CierreLoteriaGroup[]): Map<number, CeldaMetrics> {
    const totalsByBanda = new Map<number, CeldaMetrics>();

    for (const loteriaGroup of loterias) {
      for (const sorteoGroup of loteriaGroup.sorteos) {
        // ✅ NUEVO: Procesar bandas directamente (ya sumadas NUMERO + REVENTADO)
        for (const [bandaKey, bandaData] of Object.entries(sorteoGroup.bands)) {
          const banda = Number(bandaKey);
          if (!totalsByBanda.has(banda)) {
            totalsByBanda.set(banda, this.createEmptyMetrics());
          }
          const total = totalsByBanda.get(banda)!;
          total.totalVendida += bandaData.totalVendida;
          total.ganado += bandaData.ganado;
          total.comisionTotal += bandaData.comisionTotal;
          total.netoDespuesComision += bandaData.netoDespuesComision;
          total.ticketsCount += bandaData.ticketsCount;
          total.refuerzos = (total.refuerzos || 0) + (bandaData.refuerzos || 0);
        }
      }
    }

    return totalsByBanda;
  }

  /**
   * ✅ Helper: Crea métricas vacías
   */
  private static createEmptyMetrics(): CeldaMetrics {
    return {
      totalVendida: 0,
      ganado: 0,
      comisionTotal: 0,
      netoDespuesComision: 0,
      refuerzos: 0,
      ticketsCount: 0,
      jugadasCount: 0,
    };
  }

  /**
   * ✅ Helper: Acumula métricas
   */
  private static accumulateMetrics(target: CeldaMetrics, source: CeldaMetrics): void {
    target.totalVendida += source.totalVendida;
    target.ganado += source.ganado;
    target.comisionTotal += source.comisionTotal;
    target.netoDespuesComision += source.netoDespuesComision;
    target.refuerzos += source.refuerzos;
    target.ticketsCount += source.ticketsCount;
    target.jugadasCount += source.jugadasCount;
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

    // Formato de moneda para columnas numéricas (columnas 3-6)
    // ✅ ACTUALIZADO: Columnas: Lotería, Turno, [Total Vendido, Premios, Comisión, Neto]
    for (let i = 3; i <= 6; i++) {
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
