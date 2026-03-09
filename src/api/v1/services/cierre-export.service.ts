import ExcelJS from 'exceljs';
import {
  CierreWeeklyData,
  CierreBySellerData,
  CierreBySellerExportData,
  BandExportData,
  SellerLoteriaRow,
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
    data: CierreWeeklyData | CierreBySellerData | CierreBySellerExportData,
    view: CierreView,
    isExtendedPeriod: boolean = false,
    sellerData?: CierreBySellerData | null
  ): Promise<ExcelJS.Workbook> {
    const workbook = new ExcelJS.Workbook();

    workbook.creator = 'Sistema de Bancas';
    workbook.created = new Date();
    workbook.modified = new Date();

    // Vista por vendedor: una pestaña por banda con vendedores agrupados por día
    if (view === 'seller') {
      const exportData = data as CierreBySellerExportData;
      for (const bandData of exportData.bands) {
        this.addSellerBandSheet(workbook, bandData, isExtendedPeriod);
      }
      return workbook;
    }

    // Para vistas weekly: generar todas las pestañas automáticamente
    const weeklyData = data as CierreWeeklyData;

    //  NUEVO: Detectar bandas presentes en los datos (extraer de la nueva estructura)
    const bandasPresentes = this.extractBandsFromLoterias(weeklyData.loterias)
      .sort((a, b) => a - b);

    // Crear una pestaña por cada banda presente
    for (const banda of bandasPresentes) {
      this.addBandSheet(workbook, weeklyData, banda, isExtendedPeriod);
    }

    // Crear pestaña "Cierre Total" al final
    this.addTotalSheet(workbook, weeklyData);

    //  NUEVO: Agregar pestaña por vendedor si está disponible
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

    //  NUEVO: Calcular totales por banda desde la nueva estructura
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
   *  NUEVO: Jerarquía: Lotería → Sorteo → Tipo (NUMERO/REVENTADO)
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
   *  Helper: Extrae todas las bandas únicas de la estructura de loterías
   */
  private static extractBandsFromLoterias(loterias: CierreLoteriaGroup[]): number[] {
    const bandsSet = new Set<number>();

    for (const loteriaGroup of loterias) {
      for (const sorteoGroup of loteriaGroup.sorteos) {
        //  NUEVO: Extraer bandas directamente (ya sumadas NUMERO + REVENTADO)
        for (const bandaKey of Object.keys(sorteoGroup.bands)) {
          bandsSet.add(Number(bandaKey));
        }
      }
    }

    return Array.from(bandsSet);
  }

  /**
   *  Helper: Calcula totales por banda desde la estructura de loterías
   */
  private static calculateTotalsByBanda(loterias: CierreLoteriaGroup[]): Map<number, CeldaMetrics> {
    const totalsByBanda = new Map<number, CeldaMetrics>();

    for (const loteriaGroup of loterias) {
      for (const sorteoGroup of loteriaGroup.sorteos) {
        //  NUEVO: Procesar bandas directamente (ya sumadas NUMERO + REVENTADO)
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
   *  Helper: Crea métricas vacías
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
   *  Helper: Acumula métricas
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
   * Agrega pestaña pivot para una banda
   *
   * Layout:
   *   Fila 1 (grupos de fecha): Vendedor | Ventana | Lotería | Turno | [fecha1 ×4] | [fecha2 ×4] | … | [TOTAL ×4]
   *   Fila 2 (sub-headers):      mismo   |  mismo  |  mismo  | mismo | V P C N     | V P C N     | … | V P C N
   *   Filas de datos: una por (vendedor, lotería, turno)
   *   Subtotal por vendedor
   *   Fila TOTAL BANDA
   */
  private static addSellerBandSheet(
    workbook: ExcelJS.Workbook,
    bandData: BandExportData,
    _isExtendedPeriod: boolean
  ): void {
    const sheet = workbook.addWorksheet(`Banda ${bandData.band}`);

    const FIXED = 5; // Vendedor, Ventana, Lotería, Turno, Tipo
    const METRICS = 4; // Venta, Premios, Comisión, Neto
    const { fechas, rows } = bandData;
    const totalCols = FIXED + (fechas.length + 1) * METRICS; // +1 para TOTAL

    // ── Fila 1: grupo-headers de fecha ──────────────────────────────────────
    const groupHeaderValues: (string | number)[] = ['', '', '', '', ''];
    for (const fecha of fechas) {
      groupHeaderValues.push(fecha, '', '', '');
    }
    groupHeaderValues.push('TOTAL', '', '', '');

    const groupRow = sheet.addRow(groupHeaderValues);
    groupRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    groupRow.height = 20;

    // Merge la celda fija (columnas 1-4 en fila 1) — solo decorativa
    if (FIXED > 1) {
      sheet.mergeCells(groupRow.number, 1, groupRow.number, FIXED);
    }
    groupRow.getCell(1).value = `Banda ${bandData.band}`;
    groupRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
    groupRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF203764' } };

    // Merge y estilo de cada grupo de fecha
    for (let i = 0; i < fechas.length; i++) {
      const startCol = FIXED + 1 + i * METRICS;
      sheet.mergeCells(groupRow.number, startCol, groupRow.number, startCol + METRICS - 1);
      const cell = groupRow.getCell(startCol);
      cell.value = fechas[i];
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    }

    // Merge y estilo del grupo TOTAL
    const totalGroupStart = FIXED + 1 + fechas.length * METRICS;
    sheet.mergeCells(groupRow.number, totalGroupStart, groupRow.number, totalGroupStart + METRICS - 1);
    const totalGroupCell = groupRow.getCell(totalGroupStart);
    totalGroupCell.value = 'TOTAL';
    totalGroupCell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    totalGroupCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF70AD47' } };
    totalGroupCell.alignment = { horizontal: 'center', vertical: 'middle' };

    // ── Fila 2: sub-headers de métricas ─────────────────────────────────────
    const SUB = ['Venta', 'Premios', 'Comisión', 'Neto'];
    const subHeaderValues: string[] = ['Vendedor', 'Ventana', 'Lotería', 'Turno', 'Tipo'];
    for (let i = 0; i <= fechas.length; i++) {
      subHeaderValues.push(...SUB);
    }

    const subRow = sheet.addRow(subHeaderValues);
    subRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    subRow.height = 18;
    subRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF595959' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    // Congelar las dos filas de encabezado y las 4 columnas fijas
    sheet.views = [{ state: 'frozen', xSplit: FIXED, ySplit: 2 }];

    // ── Filas de datos (pivot) ───────────────────────────────────────────────
    const CURRENCY_FMT = '₡#,##0.00;-₡#,##0.00';

    const addMetricCells = (row: ExcelJS.Row, colStart: number, m: CeldaMetrics | undefined) => {
      const vals = m
        ? [m.totalVendida, m.ganado, m.comisionTotal, m.netoDespuesComision]
        : [0, 0, 0, 0];
      for (let i = 0; i < METRICS; i++) {
        const cell = row.getCell(colStart + i);
        cell.value = vals[i];
        cell.numFmt = CURRENCY_FMT;
        cell.alignment = { horizontal: 'right' };
      }
    };

    // Agrupar filas por vendedor para añadir subtotales
    let currentVendedorId = '';
    const vendedorDayTotals: Record<string, CeldaMetrics> = {};
    let vendedorTotal = this.createEmptyMetrics();
    let vendedorNombre = '';
    let ventanaNombre = '';

    const flushVendedorSubtotal = () => {
      if (!currentVendedorId) return;
      const subtotalValues: (string | number)[] = [vendedorNombre + ' — SUBTOTAL', ventanaNombre, '', '', ''];
      for (const fecha of fechas) {
        const m = vendedorDayTotals[fecha] ?? this.createEmptyMetrics();
        subtotalValues.push(m.totalVendida, m.ganado, m.comisionTotal, m.netoDespuesComision);
      }
      subtotalValues.push(vendedorTotal.totalVendida, vendedorTotal.ganado, vendedorTotal.comisionTotal, vendedorTotal.netoDespuesComision);

      const subtotalRow = sheet.addRow(subtotalValues);
      subtotalRow.font = { bold: true };
      subtotalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7E6E6' } };
      subtotalRow.eachCell({ includeEmpty: false }, (cell) => {
        if (typeof cell.value === 'number') cell.numFmt = CURRENCY_FMT;
      });
    };

    for (const loteriaRow of rows) {
      if (loteriaRow.vendedorId !== currentVendedorId) {
        flushVendedorSubtotal();
        currentVendedorId = loteriaRow.vendedorId;
        vendedorNombre = loteriaRow.vendedorNombre;
        ventanaNombre = loteriaRow.ventanaNombre;
        vendedorTotal = this.createEmptyMetrics();
        for (const key of Object.keys(vendedorDayTotals)) delete vendedorDayTotals[key];
      }

      const dataRowValues: (string | number)[] = [
        loteriaRow.vendedorNombre,
        loteriaRow.ventanaNombre,
        loteriaRow.loteriaNombre,
        loteriaRow.turno,
        loteriaRow.tipo === 'NUMERO' ? 'Número' : 'Reventado',
      ];
      for (const fecha of fechas) {
        const m = loteriaRow.dias[fecha];
        dataRowValues.push(
          m?.totalVendida ?? 0,
          m?.ganado ?? 0,
          m?.comisionTotal ?? 0,
          m?.netoDespuesComision ?? 0
        );
        if (m) {
          if (!vendedorDayTotals[fecha]) vendedorDayTotals[fecha] = this.createEmptyMetrics();
          this.accumulateMetrics(vendedorDayTotals[fecha], m);
        }
      }
      dataRowValues.push(
        loteriaRow.total.totalVendida,
        loteriaRow.total.ganado,
        loteriaRow.total.comisionTotal,
        loteriaRow.total.netoDespuesComision
      );
      this.accumulateMetrics(vendedorTotal, loteriaRow.total);

      const dataRow = sheet.addRow(dataRowValues);
      dataRow.alignment = { vertical: 'middle' };
      dataRow.eachCell({ includeEmpty: false }, (cell) => {
        if (typeof cell.value === 'number') cell.numFmt = CURRENCY_FMT;
      });
    }

    flushVendedorSubtotal();

    // ── Fila TOTAL BANDA ────────────────────────────────────────────────────
    const bandTotalValues: (string | number)[] = ['TOTAL BANDA', '', '', '', ''];
    const bandDayTotals: Record<string, CeldaMetrics> = {};
    for (const loteriaRow of rows) {
      for (const fecha of fechas) {
        const m = loteriaRow.dias[fecha];
        if (m) {
          if (!bandDayTotals[fecha]) bandDayTotals[fecha] = this.createEmptyMetrics();
          this.accumulateMetrics(bandDayTotals[fecha], m);
        }
      }
    }
    for (const fecha of fechas) {
      const m = bandDayTotals[fecha] ?? this.createEmptyMetrics();
      bandTotalValues.push(m.totalVendida, m.ganado, m.comisionTotal, m.netoDespuesComision);
    }
    bandTotalValues.push(
      bandData.total.totalVendida,
      bandData.total.ganado,
      bandData.total.comisionTotal,
      bandData.total.netoDespuesComision
    );

    const totalRow = sheet.addRow(bandTotalValues);
    this.styleGrandTotalRow(totalRow);

    // ── Anchos de columna ───────────────────────────────────────────────────
    sheet.getColumn(1).width = 28; // Vendedor
    sheet.getColumn(2).width = 18; // Ventana
    sheet.getColumn(3).width = 16; // Lotería
    sheet.getColumn(4).width = 8;  // Turno
    sheet.getColumn(5).width = 12; // Tipo
    for (let c = FIXED + 1; c <= totalCols; c++) {
      sheet.getColumn(c).width = 13;
    }
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
    //  ACTUALIZADO: Columnas: Lotería, Turno, [Total Vendido, Premios, Comisión, Neto]
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
