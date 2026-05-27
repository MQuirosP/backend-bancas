import * as ExcelJS from 'exceljs';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfMake = require('pdfmake/build/pdfmake');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfFonts = require('pdfmake/build/vfs_fonts');

/**
 * Servicio para exportar dashboard a Excel (.xlsx), CSV y PDF
 * Genera múltiples hojas con datos del dashboard
 */

export interface DashboardExportDataV2 {
  meta: {
    fromAt: string;
    toAt: string;
    tz: string;
    generatedAt: string;
  };
  summary: {
    period: {
      totalSales: number;
      totalPayouts: number;
      commissionVentana: number;
      commissionUser: number;
      totalNet: number;
      margin: number;
      totalTickets: number;
      winningTickets: number;
      winRate: number;
    };
    monthToDate: {
      totalSales: number;
      totalPayouts: number;
      commissionVentana: number;
      commissionUser: number;
      totalNet: number;
      margin: number;
    };
  };
  balances: {
    byVentana: Array<{
      ventanaName: string;
      isActive: boolean;
      sales: number;
      payouts: number;
      commissionVentana: number;
      commissionUser: number;
      net: number;
      margin: number;
      monthAccumulatedBalance: number;
    }>;
    byVendedor: Array<{
      vendedorName: string;
      ventanaName: string;
      isActive: boolean;
      sales: number;
      payouts: number;
      commissionVentana: number;
      commissionUser: number;
      net: number;
      margin: number;
      monthAccumulatedBalance: number;
    }>;
  };
  timeSeries: Array<{
    date: string;
    sales: number;
    commissions: number;
    tickets: number;
  }>;
  exposure: {
    topNumbers: Array<{
      number: string;
      betType: string;
      sales: number;
      potentialPayout: number;
      ratio: number;
      ticketCount: number;
    }>;
    byLoteria: Array<{
      loteriaName: string;
      sales: number;
      potentialPayout: number;
      ratio: number;
    }>;
  };
}

export class DashboardExportService {
  /**
   * Genera un workbook de Excel con múltiples hojas
   */
  static async generateWorkbook(data: DashboardExportDataV2): Promise<ExcelJS.Workbook> {
    const workbook = new ExcelJS.Workbook();

    workbook.creator = 'Sistema de Bancas';
    workbook.created = new Date();
    workbook.modified = new Date();

    // Hoja 1: Resumen Ejecutivo
    this.addSummarySheet(workbook, data);

    // Hoja 2: Estado de Saldos por Listero
    if (data.balances.byVentana && data.balances.byVentana.length > 0) {
      this.addBalancesSheet(workbook, data.balances.byVentana, 'Estado de Saldos por Listero', 'Listero');
    }

    // Hoja 3: Estado de Saldos por Vendedor
    if (data.balances.byVendedor && data.balances.byVendedor.length > 0) {
      this.addBalancesSheet(workbook, data.balances.byVendedor, 'Estado de Saldos por Vendedor', 'Vendedor');
    }

    // Hoja 4: TimeSeries (Datos Temporales)
    this.addTimeSeriesSheet(workbook, data.timeSeries);

    // Hoja 5: Exposure (Exposición)
    this.addExposureSheet(workbook, data.exposure);

    return workbook;
  }

  /**
   * Hoja 1: Resumen Ejecutivo
   */
  private static addSummarySheet(workbook: ExcelJS.Workbook, data: DashboardExportDataV2): void {
    const sheet = workbook.addWorksheet('Resumen Ejecutivo');

    // Información del rango de fechas
    if (data.meta) {
      sheet.addRow(['Rango de Fechas']);
      sheet.addRow(['Desde:', this.formatDateTime(data.meta.fromAt)]);
      sheet.addRow(['Hasta:', this.formatDateTime(data.meta.toAt)]);
      sheet.addRow(['Zona Horaria:', data.meta.tz]);
      sheet.addRow([]);
    }

    // 1. Resultados del Periodo Filtrado
    sheet.addRow(['Resultados del Periodo Filtrado']);
    const periodHeader = sheet.addRow(['Métrica', 'Valor']);
    this.styleHeaderRow(periodHeader);

    const { period } = data.summary;
    sheet.addRow(['Ventas Totales', this.formatCurrency(period.totalSales)]);
    sheet.addRow(['Premios Pagados', this.formatCurrency(period.totalPayouts)]);
    sheet.addRow(['Comisión Listero (Ventana)', this.formatCurrency(period.commissionVentana)]);
    sheet.addRow(['Comisión Vendedor', this.formatCurrency(period.commissionUser)]);
    sheet.addRow(['Neto de la Banca', this.formatCurrency(period.totalNet)]);
    sheet.addRow(['Margen (%)', `${period.margin.toFixed(2)}%`]);
    sheet.addRow(['Total Tickets', period.totalTickets]);
    sheet.addRow(['Tickets Ganadores', period.winningTickets]);
    sheet.addRow(['Tasa de Ganancia', `${period.winRate.toFixed(2)}%`]);
    sheet.addRow([]);

    // 2. Resultados Acumulados del Mes (Month-to-Date)
    sheet.addRow(['Resultados Acumulados del Mes (Month-to-Date)']);
    const mtdHeader = sheet.addRow(['Métrica', 'Valor']);
    this.styleHeaderRow(mtdHeader);

    const { monthToDate } = data.summary;
    sheet.addRow(['Ventas Totales (MTD)', this.formatCurrency(monthToDate.totalSales)]);
    sheet.addRow(['Premios Pagados (MTD)', this.formatCurrency(monthToDate.totalPayouts)]);
    sheet.addRow(['Comisión Listero (MTD)', this.formatCurrency(monthToDate.commissionVentana)]);
    sheet.addRow(['Comisión Vendedor (MTD)', this.formatCurrency(monthToDate.commissionUser)]);
    sheet.addRow(['Neto de la Banca (MTD)', this.formatCurrency(monthToDate.totalNet)]);
    sheet.addRow(['Margen MTD (%)', `${monthToDate.margin.toFixed(2)}%`]);
    sheet.addRow([]);

    this.styleSheetHeader(sheet);
    this.autoSizeColumns(sheet);
  }

  /**
   * Hoja 2 y 3: Estado de Saldos (Listero o Vendedor)
   */
  private static addBalancesSheet(workbook: ExcelJS.Workbook, items: any[], sheetName: string, entityLabel: string): void {
    const sheet = workbook.addWorksheet(sheetName);

    sheet.addRow([`Resumen - ${sheetName}`]);
    sheet.addRow([]);

    const headers = [
      entityLabel,
      ...(entityLabel === 'Vendedor' ? ['Ventana'] : []), // Columna extra si es vendedor
      'Estado',
      'Ventas Periodo',
      'Premios Periodo',
      'Comisión Listero',
      'Comisión Vendedor',
      'Neto Periodo',
      'Saldo a Hoy (Mes Acumulado)',
      'Estatus'
    ];
    
    const headerRow = sheet.addRow(headers);
    this.styleHeaderRow(headerRow);

    items.forEach(item => {
      const name = entityLabel === 'Vendedor' ? item.vendedorName : item.ventanaName;
      const status = item.monthAccumulatedBalance > 0 ? 'POR COBRAR' : (item.monthAccumulatedBalance < 0 ? 'POR PAGAR' : 'AL DÍA');
      
      const rowData = [
        name,
        ...(entityLabel === 'Vendedor' ? [item.ventanaName] : []),
        item.isActive ? 'Activa' : 'Inactiva',
        this.formatCurrency(item.sales),
        this.formatCurrency(item.payouts),
        this.formatCurrency(item.commissionVentana),
        this.formatCurrency(item.commissionUser),
        this.formatCurrency(item.net),
        this.formatCurrency(item.monthAccumulatedBalance),
        status
      ];

      const row = sheet.addRow(rowData);
      
      // Aplicar color de estado
      const statusCellIndex = headers.length;
      const statusCell = row.getCell(statusCellIndex);
      if (status === 'POR COBRAR') {
        statusCell.font = { color: { argb: 'FFFF0000' }, bold: true }; // Rojo (Debe a la banca)
      } else if (status === 'POR PAGAR') {
        statusCell.font = { color: { argb: 'FF0000FF' }, bold: true }; // Azul (Banca le debe)
      } else {
        statusCell.font = { color: { argb: 'FF008000' }, bold: true }; // Verde
      }
    });

    // Total Row
    const totalRowData = [
      'TOTAL',
      ...(entityLabel === 'Vendedor' ? [''] : []),
      '',
      this.formatCurrency(items.reduce((sum, i) => sum + i.sales, 0)),
      this.formatCurrency(items.reduce((sum, i) => sum + i.payouts, 0)),
      this.formatCurrency(items.reduce((sum, i) => sum + i.commissionVentana, 0)),
      this.formatCurrency(items.reduce((sum, i) => sum + i.commissionUser, 0)),
      this.formatCurrency(items.reduce((sum, i) => sum + i.net, 0)),
      this.formatCurrency(items.reduce((sum, i) => sum + i.monthAccumulatedBalance, 0)),
      ''
    ];
    
    const totalRow = sheet.addRow(totalRowData);
    this.styleTotalRow(totalRow);

    this.styleSheetHeader(sheet);
    this.autoSizeColumns(sheet);
  }

  /**
   * Hoja 4: TimeSeries (Datos Temporales)
   */
  private static addTimeSeriesSheet(workbook: ExcelJS.Workbook, timeSeries: DashboardExportDataV2['timeSeries']): void {
    const sheet = workbook.addWorksheet('Serie Temporal');

    const header = sheet.addRow([
      'Fecha',
      'Ventas',
      'Comisiones',
      'Tickets',
    ]);
    this.styleHeaderRow(header);

    if (timeSeries && timeSeries.length > 0) {
      timeSeries.forEach(item => {
        sheet.addRow([
          new Date(item.date).toLocaleDateString('es-CR'),
          this.formatCurrency(item.sales),
          this.formatCurrency(item.commissions),
          item.tickets,
        ]);
      });

      // Total
      const totalRow = sheet.addRow([
        'TOTAL',
        this.formatCurrency(timeSeries.reduce((sum, item) => sum + item.sales, 0)),
        this.formatCurrency(timeSeries.reduce((sum, item) => sum + item.commissions, 0)),
        timeSeries.reduce((sum, item) => sum + item.tickets, 0),
      ]);
      this.styleTotalRow(totalRow);
    }

    this.styleSheetHeader(sheet);
    this.autoSizeColumns(sheet);
  }

  /**
   * Hoja 5: Exposure (Exposición)
   */
  private static addExposureSheet(workbook: ExcelJS.Workbook, exposure: DashboardExportDataV2['exposure']): void {
    const sheet = workbook.addWorksheet('Exposición');

    // Top Números
    if (exposure.topNumbers && exposure.topNumbers.length > 0) {
      sheet.addRow(['Top Números con Mayor Exposición']);
      const topHeader = sheet.addRow([
        'Número',
        'Tipo',
        'Ventas',
        'Payout Potencial',
        'Ratio',
        'Tickets',
      ]);
      this.styleHeaderRow(topHeader);

      exposure.topNumbers.forEach(num => {
        sheet.addRow([
          num.number,
          num.betType,
          this.formatCurrency(num.sales),
          this.formatCurrency(num.potentialPayout),
          `${num.ratio.toFixed(2)}x`,
          num.ticketCount,
        ]);
      });
      sheet.addRow([]);
    }

    // Por Lotería
    if (exposure.byLoteria && exposure.byLoteria.length > 0) {
      sheet.addRow(['Exposición por Lotería']);
      const loteriaHeader = sheet.addRow([
        'Lotería',
        'Ventas',
        'Payout Potencial',
        'Ratio',
      ]);
      this.styleHeaderRow(loteriaHeader);

      exposure.byLoteria.forEach(l => {
        sheet.addRow([
          l.loteriaName,
          this.formatCurrency(l.sales),
          this.formatCurrency(l.potentialPayout),
          `${l.ratio.toFixed(2)}x`,
        ]);
      });
    }

    this.styleSheetHeader(sheet);
    this.autoSizeColumns(sheet);
  }

  /**
   * Genera CSV como string
   */
  static generateCSV(data: DashboardExportDataV2): string {
    const lines: string[] = [];

    // Resumen Ejecutivo
    lines.push('=== RESUMEN EJECUTIVO ===');
    if (data.meta) {
      const fromStr = this.formatDateTime(data.meta.fromAt);
      const toStr = this.formatDateTime(data.meta.toAt);
      lines.push(`Rango: ${fromStr} - ${toStr}`);
      lines.push('');
    }
    
    lines.push('=== Resultados del Periodo ===');
    lines.push('Métrica,Valor');
    lines.push(`Ventas Totales,${this.formatCurrency(data.summary.period.totalSales)}`);
    lines.push(`Premios Pagados,${this.formatCurrency(data.summary.period.totalPayouts)}`);
    lines.push(`Comisión Listero,${this.formatCurrency(data.summary.period.commissionVentana)}`);
    lines.push(`Comisión Vendedor,${this.formatCurrency(data.summary.period.commissionUser)}`);
    lines.push(`Neto de la Banca,${this.formatCurrency(data.summary.period.totalNet)}`);
    lines.push(`Margen %,${data.summary.period.margin.toFixed(2)}%`);
    lines.push(`Total Tickets,${data.summary.period.totalTickets}`);
    lines.push(`Tickets Ganadores,${data.summary.period.winningTickets}`);
    lines.push(`Tasa de Ganancia,${data.summary.period.winRate.toFixed(2)}%`);
    lines.push('');

    lines.push('=== Resultados Acumulados del Mes (MTD) ===');
    lines.push('Métrica,Valor');
    lines.push(`Ventas Totales,${this.formatCurrency(data.summary.monthToDate.totalSales)}`);
    lines.push(`Premios Pagados,${this.formatCurrency(data.summary.monthToDate.totalPayouts)}`);
    lines.push(`Comisión Listero,${this.formatCurrency(data.summary.monthToDate.commissionVentana)}`);
    lines.push(`Comisión Vendedor,${this.formatCurrency(data.summary.monthToDate.commissionUser)}`);
    lines.push(`Neto de la Banca,${this.formatCurrency(data.summary.monthToDate.totalNet)}`);
    lines.push(`Margen %,${data.summary.monthToDate.margin.toFixed(2)}%`);
    lines.push('');

    // Saldos por Listero
    if (data.balances.byVentana && data.balances.byVentana.length > 0) {
      lines.push('=== ESTADO DE SALDOS POR LISTERO ===');
      lines.push('Listero,Estado,Ventas Periodo,Premios Periodo,Comisión Listero,Comisión Vendedor,Neto Periodo,Saldo a Hoy,Estatus');
      data.balances.byVentana.forEach(v => {
        const status = v.monthAccumulatedBalance > 0 ? 'POR COBRAR' : (v.monthAccumulatedBalance < 0 ? 'POR PAGAR' : 'AL DÍA');
        lines.push([
          v.ventanaName,
          v.isActive ? 'Activa' : 'Inactiva',
          this.formatCurrency(v.sales),
          this.formatCurrency(v.payouts),
          this.formatCurrency(v.commissionVentana),
          this.formatCurrency(v.commissionUser),
          this.formatCurrency(v.net),
          this.formatCurrency(v.monthAccumulatedBalance),
          status
        ].join(','));
      });
      lines.push('');
    }

    // Saldos por Vendedor
    if (data.balances.byVendedor && data.balances.byVendedor.length > 0) {
      lines.push('=== ESTADO DE SALDOS POR VENDEDOR ===');
      lines.push('Vendedor,Ventana,Estado,Ventas Periodo,Premios Periodo,Comisión Listero,Comisión Vendedor,Neto Periodo,Saldo a Hoy,Estatus');
      data.balances.byVendedor.forEach(v => {
        const status = v.monthAccumulatedBalance > 0 ? 'POR COBRAR' : (v.monthAccumulatedBalance < 0 ? 'POR PAGAR' : 'AL DÍA');
        lines.push([
          v.vendedorName,
          v.ventanaName,
          v.isActive ? 'Activa' : 'Inactiva',
          this.formatCurrency(v.sales),
          this.formatCurrency(v.payouts),
          this.formatCurrency(v.commissionVentana),
          this.formatCurrency(v.commissionUser),
          this.formatCurrency(v.net),
          this.formatCurrency(v.monthAccumulatedBalance),
          status
        ].join(','));
      });
      lines.push('');
    }

    // TimeSeries
    if (data.timeSeries && data.timeSeries.length > 0) {
      lines.push('=== SERIE TEMPORAL ===');
      lines.push('Fecha,Ventas,Comisiones,Tickets');
      data.timeSeries.forEach(item => {
        lines.push([
          new Date(item.date).toLocaleDateString('es-CR'),
          this.formatCurrency(item.sales),
          this.formatCurrency(item.commissions),
          item.tickets,
        ].join(','));
      });
      lines.push('');
    }

    // Top Números
    if (data.exposure.topNumbers && data.exposure.topNumbers.length > 0) {
      lines.push('=== TOP NÚMEROS - EXPOSICIÓN ===');
      lines.push('Número,Tipo,Ventas,Payout Potencial,Ratio,Tickets');
      data.exposure.topNumbers.forEach(num => {
        lines.push([
          num.number,
          num.betType,
          this.formatCurrency(num.sales),
          this.formatCurrency(num.potentialPayout),
          `${num.ratio.toFixed(2)}x`,
          num.ticketCount,
        ].join(','));
      });
    }

    return lines.join('\n');
  }

  /**
   * Genera PDF con los datos del dashboard usando pdfmake
   */
  static generatePDF(data: DashboardExportDataV2): any {
    if (!pdfMake.vfs) {
      if (pdfFonts && pdfFonts.pdfMake && pdfFonts.pdfMake.vfs) {
        pdfMake.vfs = pdfFonts.pdfMake.vfs;
      } else if (pdfFonts && pdfFonts.vfs) {
        pdfMake.vfs = pdfFonts.vfs;
      }
      
      if (!pdfMake.fonts) {
        pdfMake.fonts = {
          Roboto: {
            normal: 'Roboto-Regular.ttf',
            bold: 'Roboto-Medium.ttf',
            italics: 'Roboto-Italic.ttf',
            bolditalics: 'Roboto-MediumItalic.ttf'
          }
        };
      }
    }

    const formatCurrency = (value: number): string => {
      return `₡${value.toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    };

    const content: any[] = [];

    // Encabezado del documento
    content.push({
      text: 'Reporte de Estado de Resultados y Saldos',
      style: 'header',
      margin: [0, 0, 0, 10]
    });

    if (data.meta) {
      content.push({
        text: [
          { text: 'Rango: ', bold: true },
          `${this.formatDateTime(data.meta.fromAt)} - ${this.formatDateTime(data.meta.toAt)}`
        ],
        margin: [0, 0, 0, 5]
      });
      content.push({
        text: [
          { text: 'Generado: ', bold: true },
          this.formatDateTime(data.meta.generatedAt)
        ],
        margin: [0, 0, 0, 15]
      });
    }

    // Resumen Ejecutivo
    content.push({
      text: 'Resumen Ejecutivo',
      style: 'sectionHeader',
      margin: [0, 10, 0, 10]
    });

    const summaryRows: Array<string[]> = [
      ['Ventas Totales', formatCurrency(data.summary.period.totalSales), formatCurrency(data.summary.monthToDate.totalSales)],
      ['Premios Pagados', formatCurrency(data.summary.period.totalPayouts), formatCurrency(data.summary.monthToDate.totalPayouts)],
      ['Comisión Listero', formatCurrency(data.summary.period.commissionVentana), formatCurrency(data.summary.monthToDate.commissionVentana)],
      ['Comisión Vendedor', formatCurrency(data.summary.period.commissionUser), formatCurrency(data.summary.monthToDate.commissionUser)],
      ['Neto de la Banca', formatCurrency(data.summary.period.totalNet), formatCurrency(data.summary.monthToDate.totalNet)],
      ['Margen', `${data.summary.period.margin.toFixed(2)}%`, `${data.summary.monthToDate.margin.toFixed(2)}%`]
    ];

    const summaryTableBody = [
      [
        { text: 'Métrica', style: 'tableHeader', bold: true },
        { text: 'Periodo Filtrado', style: 'tableHeader', bold: true },
        { text: 'Mes Acumulado (MTD)', style: 'tableHeader', bold: true }
      ]
    ];

    summaryRows.forEach(row => summaryTableBody.push(row as any));

    content.push({
      table: {
        headerRows: 1,
        widths: ['*', '*', '*'],
        body: summaryTableBody
      },
      layout: {
        fillColor: (rowIndex: number) => {
          if (rowIndex === 0) return '#4472C4';
          return rowIndex % 2 === 0 ? '#F9F9F9' : null;
        }
      },
      margin: [0, 0, 0, 15]
    });

    // Saldos por Listero
    if (data.balances.byVentana && data.balances.byVentana.length > 0) {
      content.push({
        text: 'Estado de Saldos por Listero',
        style: 'sectionHeader',
        margin: [0, 10, 0, 10]
      });

      const ventanaTableBody: any[] = [
        [
          { text: 'Listero', style: 'tableHeader', bold: true },
          { text: 'Ventas Periodo', style: 'tableHeader', bold: true },
          { text: 'Neto Periodo', style: 'tableHeader', bold: true },
          { text: 'Saldo a Hoy', style: 'tableHeader', bold: true },
          { text: 'Estatus', style: 'tableHeader', bold: true }
        ]
      ];

      data.balances.byVentana.forEach(v => {
        const status = v.monthAccumulatedBalance > 0 ? 'POR COBRAR' : (v.monthAccumulatedBalance < 0 ? 'POR PAGAR' : 'AL DÍA');
        const statusColor = v.monthAccumulatedBalance > 0 ? '#FF0000' : (v.monthAccumulatedBalance < 0 ? '#0000FF' : '#008000');
        
        ventanaTableBody.push([
          v.ventanaName,
          formatCurrency(v.sales),
          formatCurrency(v.net),
          formatCurrency(v.monthAccumulatedBalance),
          { text: status, color: statusColor, bold: true }
        ]);
      });

      content.push({
        table: {
          headerRows: 1,
          widths: ['*', 'auto', 'auto', 'auto', 'auto'],
          body: ventanaTableBody
        },
        layout: {
          fillColor: (rowIndex: number) => {
            if (rowIndex === 0) return '#4472C4';
            return rowIndex % 2 === 0 ? '#F9F9F9' : null;
          }
        },
        margin: [0, 0, 0, 15]
      });
    }

    // Saldos por Vendedor
    if (data.balances.byVendedor && data.balances.byVendedor.length > 0) {
      content.push({
        text: 'Estado de Saldos por Vendedor',
        style: 'sectionHeader',
        margin: [0, 10, 0, 10]
      });

      const vendedorTableBody: any[] = [
        [
          { text: 'Vendedor', style: 'tableHeader', bold: true },
          { text: 'Listero', style: 'tableHeader', bold: true },
          { text: 'Ventas Periodo', style: 'tableHeader', bold: true },
          { text: 'Neto Periodo', style: 'tableHeader', bold: true },
          { text: 'Saldo a Hoy', style: 'tableHeader', bold: true },
          { text: 'Estatus', style: 'tableHeader', bold: true }
        ]
      ];

      data.balances.byVendedor.forEach(v => {
        const status = v.monthAccumulatedBalance > 0 ? 'POR COBRAR' : (v.monthAccumulatedBalance < 0 ? 'POR PAGAR' : 'AL DÍA');
        const statusColor = v.monthAccumulatedBalance > 0 ? '#FF0000' : (v.monthAccumulatedBalance < 0 ? '#0000FF' : '#008000');

        vendedorTableBody.push([
          v.vendedorName,
          v.ventanaName,
          formatCurrency(v.sales),
          formatCurrency(v.net),
          formatCurrency(v.monthAccumulatedBalance),
          { text: status, color: statusColor, bold: true }
        ]);
      });

      content.push({
        table: {
          headerRows: 1,
          widths: ['*', '*', 'auto', 'auto', 'auto', 'auto'],
          body: vendedorTableBody
        },
        layout: {
          fillColor: (rowIndex: number) => {
            if (rowIndex === 0) return '#4472C4';
            return rowIndex % 2 === 0 ? '#F9F9F9' : null;
          }
        },
        margin: [0, 0, 0, 15]
      });
    }

    // Top Números - Exposición
    if (data.exposure.topNumbers && data.exposure.topNumbers.length > 0) {
      content.push({
        text: 'Top 10 Números - Exposición',
        style: 'sectionHeader',
        margin: [0, 10, 0, 10]
      });

      const exposureTableBody: any[] = [
        [
          { text: 'Número', style: 'tableHeader', bold: true },
          { text: 'Tipo', style: 'tableHeader', bold: true },
          { text: 'Ventas', style: 'tableHeader', bold: true },
          { text: 'Payout Potencial', style: 'tableHeader', bold: true },
          { text: 'Ratio', style: 'tableHeader', bold: true },
          { text: 'Tickets', style: 'tableHeader', bold: true }
        ]
      ];

      data.exposure.topNumbers.slice(0, 10).forEach(num => {
        exposureTableBody.push([
          num.number,
          num.betType,
          formatCurrency(num.sales),
          formatCurrency(num.potentialPayout),
          `${num.ratio.toFixed(2)}x`,
          num.ticketCount.toString()
        ]);
      });

      content.push({
        table: {
          headerRows: 1,
          widths: ['auto', 'auto', 'auto', 'auto', 'auto', 'auto'],
          body: exposureTableBody
        },
        layout: {
          fillColor: (rowIndex: number) => {
            if (rowIndex === 0) return '#4472C4';
            return rowIndex % 2 === 0 ? '#F9F9F9' : null;
          }
        },
        margin: [0, 0, 0, 15]
      });
    }

    const docDefinition: any = {
      content,
      defaultStyle: {
        font: 'Roboto',
        fontSize: 10
      },
      styles: {
        header: {
          fontSize: 20,
          bold: true,
          alignment: 'center',
          margin: [0, 0, 0, 10]
        },
        sectionHeader: {
          fontSize: 14,
          bold: true,
          margin: [0, 10, 0, 10],
          decoration: 'underline'
        },
        tableHeader: {
          bold: true,
          fontSize: 10,
          color: 'white',
          fillColor: '#4472C4',
          alignment: 'center'
        }
      },
      pageMargins: [40, 60, 40, 60],
      footer: function(currentPage: number, pageCount: number) {
        return {
          text: `Página ${currentPage} de ${pageCount}`,
          alignment: 'right',
          fontSize: 8,
          margin: [0, 10, 40, 0]
        };
      }
    };

    return pdfMake.createPdf(docDefinition);
  }

  /**
   * Utilidades de formato y estilo
   */
  private static formatCurrency(value: number): string {
    return `₡${value.toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  private static formatDateTime(value: string): string {
    if (!value) return '';
    const date = new Date(value);
    return date.toLocaleString('es-CR', {
      timeZone: 'America/Costa_Rica',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private static styleSheetHeader(sheet: ExcelJS.Worksheet): void {
    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
  }

  private static styleHeaderRow(row: ExcelJS.Row): void {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' },
    };
    row.alignment = { vertical: 'middle', horizontal: 'center' };
  }

  private static styleTotalRow(row: ExcelJS.Row): void {
    row.font = { bold: true };
    row.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF2F2F2' },
    };
  }

  private static autoSizeColumns(sheet: ExcelJS.Worksheet): void {
    const processColumn = (column: any) => {
      if (column && column.eachCell) {
        let maxLength = 0;
        column.eachCell({ includeEmpty: false }, (cell: ExcelJS.Cell) => {
          const columnLength = cell.value ? cell.value.toString().length : 10;
          if (columnLength > maxLength) {
            maxLength = columnLength;
          }
        });
        column.width = maxLength < 10 ? 10 : maxLength + 2;
      }
    };

    if (sheet.columns && sheet.columns.length > 0) {
      sheet.columns.forEach(processColumn);
    } else if (sheet.columnCount > 0) {
      for (let i = 1; i <= sheet.columnCount; i++) {
        processColumn(sheet.getColumn(i));
      }
    }
  }
}
