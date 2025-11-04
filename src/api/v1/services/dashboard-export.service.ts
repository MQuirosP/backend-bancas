import ExcelJS from 'exceljs';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfMake = require('pdfmake/build/pdfmake');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfFonts = require('pdfmake/build/vfs_fonts');

/**
 * Servicio para exportar dashboard a Excel (.xlsx), CSV y PDF
 * Genera múltiples hojas con datos del dashboard
 */

interface DashboardExportData {
  ganancia: {
    totalAmount: number;
    totalSales: number;
    margin: number;
    byVentana: Array<{
      ventanaId: string;
      ventanaName: string;
      sales: number;
      amount: number;
      commissions: number;
      payout: number;
      margin: number;
      tickets: number;
      winners: number;
      winRate: number;
      isActive: boolean;
    }>;
    byLoteria: Array<{
      loteriaId: string;
      loteriaName: string;
      sales: number;
      amount: number;
      commissions: number;
      payout: number;
      margin: number;
      tickets: number;
      winners: number;
      winRate: number;
      isActive: boolean;
    }>;
  };
  cxc: {
    totalAmount: number;
    byVentana: Array<{
      ventanaId: string;
      ventanaName: string;
      totalSales: number;
      totalPaidOut: number;
      amount: number;
      isActive: boolean;
    }>;
  };
  cxp: {
    totalAmount: number;
    byVentana: Array<{
      ventanaId: string;
      ventanaName: string;
      totalWinners: number;
      totalPaidOut: number;
      amount: number;
      isActive: boolean;
    }>;
  };
  summary: {
    totalSales: number;
    totalPayouts: number;
    totalCommissions: number;
    totalTickets: number;
    winningTickets: number;
    winRate: number;
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
    heatmap: Array<{
      number: string;
      sales: number;
    }>;
    byLoteria: Array<{
      loteriaId: string;
      loteriaName: string;
      sales: number;
      potentialPayout: number;
      ratio: number;
    }>;
  };
  previousPeriod?: any;
  alerts?: Array<{
    type: string;
    severity: string;
    message: string;
    action?: string;
  }>;
  meta?: {
    range: {
      fromAt: string;
      toAt: string;
      tz: string;
    };
    generatedAt: string;
  };
}

export class DashboardExportService {
  /**
   * Genera un workbook de Excel con múltiples hojas
   */
  static async generateWorkbook(data: DashboardExportData): Promise<ExcelJS.Workbook> {
    const workbook = new ExcelJS.Workbook();

    workbook.creator = 'Sistema de Bancas';
    workbook.created = new Date();
    workbook.modified = new Date();

    // Hoja 1: Resumen Ejecutivo
    this.addSummarySheet(workbook, data);

    // Hoja 2: Ganancia
    this.addGananciaSheet(workbook, data.ganancia);

    // Hoja 3: CxC (Cuentas por Cobrar)
    this.addCxCSheet(workbook, data.cxc);

    // Hoja 4: CxP (Cuentas por Pagar)
    this.addCxPSheet(workbook, data.cxp);

    // Hoja 5: TimeSeries (Datos Temporales)
    this.addTimeSeriesSheet(workbook, data.timeSeries);

    // Hoja 6: Exposure (Exposición)
    this.addExposureSheet(workbook, data.exposure);

    // Hoja 7: Alertas (si existen)
    if (data.alerts && data.alerts.length > 0) {
      this.addAlertsSheet(workbook, data.alerts);
    }

    return workbook;
  }

  /**
   * Hoja 1: Resumen Ejecutivo
   */
  private static addSummarySheet(workbook: ExcelJS.Workbook, data: DashboardExportData): void {
    const sheet = workbook.addWorksheet('Resumen Ejecutivo');

    // Información del rango de fechas
    if (data.meta?.range) {
      sheet.addRow(['Rango de Fechas']);
      sheet.addRow(['Desde:', data.meta.range.fromAt]);
      sheet.addRow(['Hasta:', data.meta.range.toAt]);
      sheet.addRow(['Zona Horaria:', data.meta.range.tz]);
      sheet.addRow([]);
    }

    // KPI principales
    sheet.addRow(['Resumen General']);
    const summaryHeader = sheet.addRow([
      'Métrica',
      'Valor',
    ]);
    this.styleHeaderRow(summaryHeader);

    sheet.addRow(['Ventas Totales', this.formatCurrency(data.summary.totalSales)]);
    sheet.addRow(['Pagos Totales', this.formatCurrency(data.summary.totalPayouts)]);
    sheet.addRow(['Comisiones Totales', this.formatCurrency(data.summary.totalCommissions)]);
    sheet.addRow(['Total Tickets', data.summary.totalTickets]);
    sheet.addRow(['Tickets Ganadores', data.summary.winningTickets]);
    sheet.addRow(['Tasa de Ganancia', `${data.summary.winRate.toFixed(2)}%`]);
    sheet.addRow([]);

    // Totales de Ganancia
    sheet.addRow(['Ganancia']);
    sheet.addRow(['Total Ganancia', this.formatCurrency(data.ganancia.totalAmount)]);
    sheet.addRow(['Total Ventas', this.formatCurrency(data.ganancia.totalSales)]);
    sheet.addRow(['Margen', `${data.ganancia.margin.toFixed(2)}%`]);
    sheet.addRow([]);

    // CxC y CxP
    sheet.addRow(['Cuentas por Cobrar (CxC)', this.formatCurrency(data.cxc.totalAmount)]);
    sheet.addRow(['Cuentas por Pagar (CxP)', this.formatCurrency(data.cxp.totalAmount)]);
    sheet.addRow([]);

    // Top 5 números con mayor exposición
    if (data.exposure.topNumbers && data.exposure.topNumbers.length > 0) {
      sheet.addRow(['Top 5 Números con Mayor Exposición']);
      const exposureHeader = sheet.addRow([
        'Número',
        'Tipo',
        'Ventas',
        'Payout Potencial',
        'Ratio',
      ]);
      this.styleHeaderRow(exposureHeader);

      data.exposure.topNumbers.slice(0, 5).forEach(num => {
        sheet.addRow([
          num.number,
          num.betType,
          this.formatCurrency(num.sales),
          this.formatCurrency(num.potentialPayout),
          `${num.ratio.toFixed(2)}x`,
        ]);
      });
    }

    this.styleSheetHeader(sheet);
    this.autoSizeColumns(sheet);
  }

  /**
   * Hoja 2: Ganancia
   */
  private static addGananciaSheet(workbook: ExcelJS.Workbook, ganancia: DashboardExportData['ganancia']): void {
    const sheet = workbook.addWorksheet('Ganancia');

    // Totales
    sheet.addRow(['Resumen de Ganancia']);
    sheet.addRow(['Total Ganancia', this.formatCurrency(ganancia.totalAmount)]);
    sheet.addRow(['Total Ventas', this.formatCurrency(ganancia.totalSales)]);
    sheet.addRow(['Margen', `${ganancia.margin.toFixed(2)}%`]);
    sheet.addRow([]);

    // Por Ventana
    if (ganancia.byVentana && ganancia.byVentana.length > 0) {
      sheet.addRow(['Ganancia por Ventana']);
      const ventanaHeader = sheet.addRow([
        'Ventana',
        'Ventas',
        'Comisiones',
        'Payout',
        'Ganancia',
        'Margen (%)',
        'Tickets',
        'Ganadores',
        'Tasa Ganancia (%)',
        'Estado',
      ]);
      this.styleHeaderRow(ventanaHeader);

      ganancia.byVentana.forEach(v => {
        sheet.addRow([
          v.ventanaName,
          this.formatCurrency(v.sales),
          this.formatCurrency(v.commissions),
          this.formatCurrency(v.payout),
          this.formatCurrency(v.amount),
          v.margin.toFixed(2),
          v.tickets,
          v.winners,
          v.winRate.toFixed(2),
          v.isActive ? 'Activa' : 'Inactiva',
        ]);
      });

      // Total
      const totalRow = sheet.addRow([
        'TOTAL',
        this.formatCurrency(ganancia.byVentana.reduce((sum, v) => sum + v.sales, 0)),
        this.formatCurrency(ganancia.byVentana.reduce((sum, v) => sum + v.commissions, 0)),
        this.formatCurrency(ganancia.byVentana.reduce((sum, v) => sum + v.payout, 0)),
        this.formatCurrency(ganancia.byVentana.reduce((sum, v) => sum + v.amount, 0)),
        '',
        ganancia.byVentana.reduce((sum, v) => sum + v.tickets, 0),
        ganancia.byVentana.reduce((sum, v) => sum + v.winners, 0),
        '',
        '',
      ]);
      this.styleTotalRow(totalRow);
      sheet.addRow([]);
    }

    // Por Lotería
    if (ganancia.byLoteria && ganancia.byLoteria.length > 0) {
      sheet.addRow(['Ganancia por Lotería']);
      const loteriaHeader = sheet.addRow([
        'Lotería',
        'Ventas',
        'Comisiones',
        'Payout',
        'Ganancia',
        'Margen (%)',
        'Tickets',
        'Ganadores',
        'Tasa Ganancia (%)',
        'Estado',
      ]);
      this.styleHeaderRow(loteriaHeader);

      ganancia.byLoteria.forEach(l => {
        // Calcular winRate si no existe (tickets > 0)
        const winRate = l.tickets > 0 ? ((l.winners || 0) / l.tickets) * 100 : 0;
        
        sheet.addRow([
          l.loteriaName,
          this.formatCurrency(l.sales),
          this.formatCurrency(l.commissions),
          this.formatCurrency(l.payout),
          this.formatCurrency(l.amount),
          (l.margin || 0).toFixed(2),
          l.tickets || 0,
          l.winners || 0,
          winRate.toFixed(2),
          l.isActive ? 'Activa' : 'Inactiva',
        ]);
      });
    }

    this.styleSheetHeader(sheet);
    this.autoSizeColumns(sheet);
  }

  /**
   * Hoja 3: CxC (Cuentas por Cobrar)
   */
  private static addCxCSheet(workbook: ExcelJS.Workbook, cxc: DashboardExportData['cxc']): void {
    const sheet = workbook.addWorksheet('Cuentas por Cobrar');

    sheet.addRow(['Resumen de Cuentas por Cobrar']);
    sheet.addRow(['Total CxC', this.formatCurrency(cxc.totalAmount)]);
    sheet.addRow([]);

    if (cxc.byVentana && cxc.byVentana.length > 0) {
      const header = sheet.addRow([
        'Ventana',
        'Ventas Totales',
        'Pagos Totales',
        'Monto CxC',
        'Estado',
      ]);
      this.styleHeaderRow(header);

      cxc.byVentana.forEach(v => {
        sheet.addRow([
          v.ventanaName,
          this.formatCurrency(v.totalSales),
          this.formatCurrency(v.totalPaidOut),
          this.formatCurrency(v.amount),
          v.isActive ? 'Activa' : 'Inactiva',
        ]);
      });

      // Total
      const totalRow = sheet.addRow([
        'TOTAL',
        this.formatCurrency(cxc.byVentana.reduce((sum, v) => sum + v.totalSales, 0)),
        this.formatCurrency(cxc.byVentana.reduce((sum, v) => sum + v.totalPaidOut, 0)),
        this.formatCurrency(cxc.byVentana.reduce((sum, v) => sum + v.amount, 0)),
        '',
      ]);
      this.styleTotalRow(totalRow);
    }

    this.styleSheetHeader(sheet);
    this.autoSizeColumns(sheet);
  }

  /**
   * Hoja 4: CxP (Cuentas por Pagar)
   */
  private static addCxPSheet(workbook: ExcelJS.Workbook, cxp: DashboardExportData['cxp']): void {
    const sheet = workbook.addWorksheet('Cuentas por Pagar');

    sheet.addRow(['Resumen de Cuentas por Pagar']);
    sheet.addRow(['Total CxP', this.formatCurrency(cxp.totalAmount)]);
    sheet.addRow([]);

    if (cxp.byVentana && cxp.byVentana.length > 0) {
      const header = sheet.addRow([
        'Ventana',
        'Total Ganadores',
        'Pagos Totales',
        'Monto CxP',
        'Estado',
      ]);
      this.styleHeaderRow(header);

      cxp.byVentana.forEach(v => {
        sheet.addRow([
          v.ventanaName,
          v.totalWinners,
          this.formatCurrency(v.totalPaidOut),
          this.formatCurrency(v.amount),
          v.isActive ? 'Activa' : 'Inactiva',
        ]);
      });

      // Total
      const totalRow = sheet.addRow([
        'TOTAL',
        cxp.byVentana.reduce((sum, v) => sum + v.totalWinners, 0),
        this.formatCurrency(cxp.byVentana.reduce((sum, v) => sum + v.totalPaidOut, 0)),
        this.formatCurrency(cxp.byVentana.reduce((sum, v) => sum + v.amount, 0)),
        '',
      ]);
      this.styleTotalRow(totalRow);
    }

    this.styleSheetHeader(sheet);
    this.autoSizeColumns(sheet);
  }

  /**
   * Hoja 5: TimeSeries (Datos Temporales)
   */
  private static addTimeSeriesSheet(workbook: ExcelJS.Workbook, timeSeries: DashboardExportData['timeSeries']): void {
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
   * Hoja 6: Exposure (Exposición)
   */
  private static addExposureSheet(workbook: ExcelJS.Workbook, exposure: DashboardExportData['exposure']): void {
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
   * Hoja 7: Alertas
   */
  private static addAlertsSheet(workbook: ExcelJS.Workbook, alerts: DashboardExportData['alerts']): void {
    const sheet = workbook.addWorksheet('Alertas');

    const header = sheet.addRow([
      'Tipo',
      'Severidad',
      'Mensaje',
      'Acción Recomendada',
    ]);
    this.styleHeaderRow(header);

    if (alerts && alerts.length > 0) {
      alerts.forEach(alert => {
        const severityColor = this.getSeverityColor(alert.severity);
        const row = sheet.addRow([
          alert.type,
          alert.severity,
          alert.message,
          alert.action || '',
        ]);

        // Aplicar color según severidad
        row.getCell(2).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: severityColor },
        };
        row.getCell(2).font = { color: { argb: 'FFFFFFFF' }, bold: true };
      });
    }

    this.styleSheetHeader(sheet);
    this.autoSizeColumns(sheet);
  }

  /**
   * Genera CSV como string
   */
  static generateCSV(data: DashboardExportData): string {
    const lines: string[] = [];

    // Resumen Ejecutivo
    lines.push('=== RESUMEN EJECUTIVO ===');
    if (data.meta?.range) {
      lines.push(`Rango: ${data.meta.range.fromAt} - ${data.meta.range.toAt}`);
      lines.push('');
    }
    lines.push('Métrica,Valor');
    lines.push(`Ventas Totales,${this.formatCurrency(data.summary.totalSales)}`);
    lines.push(`Pagos Totales,${this.formatCurrency(data.summary.totalPayouts)}`);
    lines.push(`Comisiones Totales,${this.formatCurrency(data.summary.totalCommissions)}`);
    lines.push(`Total Tickets,${data.summary.totalTickets}`);
    lines.push(`Tickets Ganadores,${data.summary.winningTickets}`);
    lines.push(`Tasa de Ganancia,${data.summary.winRate.toFixed(2)}%`);
    lines.push('');
    lines.push(`Ganancia Total,${this.formatCurrency(data.ganancia.totalAmount)}`);
    lines.push(`CxC Total,${this.formatCurrency(data.cxc.totalAmount)}`);
    lines.push(`CxP Total,${this.formatCurrency(data.cxp.totalAmount)}`);
    lines.push('');
    lines.push('');

    // Ganancia por Ventana
    if (data.ganancia.byVentana && data.ganancia.byVentana.length > 0) {
      lines.push('=== GANANCIA POR VENTANA ===');
      lines.push('Ventana,Ventas,Comisiones,Payout,Ganancia,Margen %,Tickets,Ganadores');
      data.ganancia.byVentana.forEach(v => {
        lines.push([
          v.ventanaName,
          this.formatCurrency(v.sales),
          this.formatCurrency(v.commissions),
          this.formatCurrency(v.payout),
          this.formatCurrency(v.amount),
          v.margin.toFixed(2),
          v.tickets,
          v.winners,
        ].join(','));
      });
      lines.push('');
    }

    // CxC
    if (data.cxc.byVentana && data.cxc.byVentana.length > 0) {
      lines.push('=== CUENTAS POR COBRAR ===');
      lines.push('Ventana,Ventas Totales,Pagos Totales,Monto CxC');
      data.cxc.byVentana.forEach(v => {
        lines.push([
          v.ventanaName,
          this.formatCurrency(v.totalSales),
          this.formatCurrency(v.totalPaidOut),
          this.formatCurrency(v.amount),
        ].join(','));
      });
      lines.push('');
    }

    // CxP
    if (data.cxp.byVentana && data.cxp.byVentana.length > 0) {
      lines.push('=== CUENTAS POR PAGAR ===');
      lines.push('Ventana,Total Ganadores,Pagos Totales,Monto CxP');
      data.cxp.byVentana.forEach(v => {
        lines.push([
          v.ventanaName,
          v.totalWinners,
          this.formatCurrency(v.totalPaidOut),
          this.formatCurrency(v.amount),
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
  static generatePDF(data: DashboardExportData): any {
    // Inicializar pdfMake con fuentes
    // pdfMake desde build/pdfmake.js ya está como objeto
    if (!pdfMake.vfs) {
      // vfs_fonts exporta como pdfMake.vfs
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

    // Helper para formato de moneda
    const formatCurrency = (value: number): string => {
      return `₡${value.toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    };

    // Helper para colores de severidad
    const getSeverityColor = (severity: string): string => {
      switch (severity.toLowerCase()) {
        case 'critical':
          return '#FF0000';
        case 'warn':
        case 'warning':
          return '#FFA500';
        case 'info':
          return '#0066CC';
        default:
          return '#808080';
      }
    };

    // Construir contenido del documento
    const content: any[] = [];

    // Encabezado del documento
    content.push({
      text: 'Reporte de Dashboard',
      style: 'header',
      margin: [0, 0, 0, 10]
    });

    // Información del rango de fechas
    if (data.meta?.range) {
      content.push({
        text: [
          { text: 'Rango: ', bold: true },
          `${new Date(data.meta.range.fromAt).toLocaleDateString('es-CR')} - ${new Date(data.meta.range.toAt).toLocaleDateString('es-CR')}`
        ],
        margin: [0, 0, 0, 5]
      });
      content.push({
        text: [
          { text: 'Generado: ', bold: true },
          new Date(data.meta.generatedAt).toLocaleString('es-CR')
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

    content.push({
      columns: [
        {
          width: '*',
          text: [
            { text: 'Ventas Totales: ', bold: true },
            formatCurrency(data.summary.totalSales)
          ]
        },
        {
          width: '*',
          text: [
            { text: 'Pagos Totales: ', bold: true },
            formatCurrency(data.summary.totalPayouts)
          ]
        }
      ],
      margin: [0, 0, 0, 5]
    });

    content.push({
      columns: [
        {
          width: '*',
          text: [
            { text: 'Comisiones Totales: ', bold: true },
            formatCurrency(data.summary.totalCommissions)
          ]
        },
        {
          width: '*',
          text: [
            { text: 'Total Tickets: ', bold: true },
            data.summary.totalTickets.toString()
          ]
        }
      ],
      margin: [0, 0, 0, 5]
    });

    content.push({
      columns: [
        {
          width: '*',
          text: [
            { text: 'Tickets Ganadores: ', bold: true },
            data.summary.winningTickets.toString()
          ]
        },
        {
          width: '*',
          text: [
            { text: 'Tasa de Ganancia: ', bold: true },
            `${data.summary.winRate.toFixed(2)}%`
          ]
        }
      ],
      margin: [0, 0, 0, 5]
    });

    content.push({
      columns: [
        {
          width: '*',
          text: [
            { text: 'Ganancia Total: ', bold: true, fontSize: 12 },
            { text: formatCurrency(data.ganancia.totalAmount), fontSize: 12 }
          ]
        },
        {
          width: '*',
          text: [
            { text: 'CxC Total: ', bold: true },
            formatCurrency(data.cxc.totalAmount)
          ]
        },
        {
          width: '*',
          text: [
            { text: 'CxP Total: ', bold: true },
            formatCurrency(data.cxp.totalAmount)
          ]
        }
      ],
      margin: [0, 10, 0, 15]
    });

    // Ganancia por Ventana
    if (data.ganancia.byVentana && data.ganancia.byVentana.length > 0) {
      content.push({
        text: 'Ganancia por Ventana',
        style: 'sectionHeader',
        margin: [0, 10, 0, 10]
      });

      const gananciaTableBody: any[] = [
        [
          { text: 'Ventana', style: 'tableHeader', bold: true },
          { text: 'Ventas', style: 'tableHeader', bold: true },
          { text: 'Comisiones', style: 'tableHeader', bold: true },
          { text: 'Payout', style: 'tableHeader', bold: true },
          { text: 'Ganancia', style: 'tableHeader', bold: true },
          { text: 'Margen %', style: 'tableHeader', bold: true }
        ]
      ];

      data.ganancia.byVentana.forEach(v => {
        gananciaTableBody.push([
          v.ventanaName,
          formatCurrency(v.sales),
          formatCurrency(v.commissions),
          formatCurrency(v.payout),
          formatCurrency(v.amount),
          `${v.margin.toFixed(2)}%`
        ]);
      });

      // Total
      gananciaTableBody.push([
        { text: 'TOTAL', bold: true, fillColor: '#F2F2F2' },
        { text: formatCurrency(data.ganancia.byVentana.reduce((sum, v) => sum + v.sales, 0)), bold: true, fillColor: '#F2F2F2' },
        { text: formatCurrency(data.ganancia.byVentana.reduce((sum, v) => sum + v.commissions, 0)), bold: true, fillColor: '#F2F2F2' },
        { text: formatCurrency(data.ganancia.byVentana.reduce((sum, v) => sum + v.payout, 0)), bold: true, fillColor: '#F2F2F2' },
        { text: formatCurrency(data.ganancia.byVentana.reduce((sum, v) => sum + v.amount, 0)), bold: true, fillColor: '#F2F2F2' },
        { text: '', fillColor: '#F2F2F2' }
      ]);

      content.push({
        table: {
          headerRows: 1,
          widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto'],
          body: gananciaTableBody
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

    // CxC
    if (data.cxc.byVentana && data.cxc.byVentana.length > 0) {
      content.push({
        text: 'Cuentas por Cobrar (CxC)',
        style: 'sectionHeader',
        margin: [0, 10, 0, 10]
      });

      const cxcTableBody: any[] = [
        [
          { text: 'Ventana', style: 'tableHeader', bold: true },
          { text: 'Ventas Totales', style: 'tableHeader', bold: true },
          { text: 'Pagos Totales', style: 'tableHeader', bold: true },
          { text: 'Monto CxC', style: 'tableHeader', bold: true }
        ]
      ];

      data.cxc.byVentana.forEach(v => {
        cxcTableBody.push([
          v.ventanaName,
          formatCurrency(v.totalSales),
          formatCurrency(v.totalPaidOut),
          formatCurrency(v.amount)
        ]);
      });

      cxcTableBody.push([
        { text: 'TOTAL', bold: true, fillColor: '#F2F2F2' },
        { text: formatCurrency(data.cxc.byVentana.reduce((sum, v) => sum + v.totalSales, 0)), bold: true, fillColor: '#F2F2F2' },
        { text: formatCurrency(data.cxc.byVentana.reduce((sum, v) => sum + v.totalPaidOut, 0)), bold: true, fillColor: '#F2F2F2' },
        { text: formatCurrency(data.cxc.byVentana.reduce((sum, v) => sum + v.amount, 0)), bold: true, fillColor: '#F2F2F2' }
      ]);

      content.push({
        table: {
          headerRows: 1,
          widths: ['*', 'auto', 'auto', 'auto'],
          body: cxcTableBody
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

    // CxP
    if (data.cxp.byVentana && data.cxp.byVentana.length > 0) {
      content.push({
        text: 'Cuentas por Pagar (CxP)',
        style: 'sectionHeader',
        margin: [0, 10, 0, 10]
      });

      const cxpTableBody: any[] = [
        [
          { text: 'Ventana', style: 'tableHeader', bold: true },
          { text: 'Total Ganadores', style: 'tableHeader', bold: true },
          { text: 'Pagos Totales', style: 'tableHeader', bold: true },
          { text: 'Monto CxP', style: 'tableHeader', bold: true }
        ]
      ];

      data.cxp.byVentana.forEach(v => {
        cxpTableBody.push([
          v.ventanaName,
          v.totalWinners.toString(),
          formatCurrency(v.totalPaidOut),
          formatCurrency(v.amount)
        ]);
      });

      cxpTableBody.push([
        { text: 'TOTAL', bold: true, fillColor: '#F2F2F2' },
        { text: data.cxp.byVentana.reduce((sum, v) => sum + v.totalWinners, 0).toString(), bold: true, fillColor: '#F2F2F2' },
        { text: formatCurrency(data.cxp.byVentana.reduce((sum, v) => sum + v.totalPaidOut, 0)), bold: true, fillColor: '#F2F2F2' },
        { text: formatCurrency(data.cxp.byVentana.reduce((sum, v) => sum + v.amount, 0)), bold: true, fillColor: '#F2F2F2' }
      ]);

      content.push({
        table: {
          headerRows: 1,
          widths: ['*', 'auto', 'auto', 'auto'],
          body: cxpTableBody
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

    // Alertas
    if (data.alerts && data.alerts.length > 0) {
      content.push({
        text: 'Alertas',
        style: 'sectionHeader',
        margin: [0, 10, 0, 10]
      });

      data.alerts.forEach(alert => {
        const severityColor = getSeverityColor(alert.severity);
        content.push({
          columns: [
            {
              width: 20,
              canvas: [
                {
                  type: 'rect',
                  x: 0,
                  y: 0,
                  w: 10,
                  h: 10,
                  color: severityColor
                }
              ]
            },
            {
              width: '*',
              text: [
                { text: `${alert.severity.toUpperCase()}: `, bold: true, color: severityColor },
                alert.message
              ],
              margin: [5, 0, 0, 0]
            }
          ],
          margin: [0, 0, 0, 5]
        });

        if (alert.action) {
          content.push({
            text: `  → ${alert.action}`,
            fontSize: 9,
            italics: true,
            color: '#666666',
            margin: [25, 0, 0, 5]
          });
        }
      });
    }

    // Definición del documento
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

    // Crear y retornar el PDF
    return pdfMake.createPdf(docDefinition);
  }

  /**
   * Utilidades de formato y estilo
   */
  private static formatCurrency(value: number): string {
    return `₡${value.toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
    sheet.columns.forEach((column) => {
      if (column && column.eachCell) {
        let maxLength = 0;
        column.eachCell({ includeEmpty: false }, (cell) => {
          const columnLength = cell.value ? cell.value.toString().length : 10;
          if (columnLength > maxLength) {
            maxLength = columnLength;
          }
        });
        column.width = maxLength < 10 ? 10 : maxLength + 2;
      }
    });
  }

  private static getSeverityColor(severity: string): string {
    switch (severity.toLowerCase()) {
      case 'critical':
        return 'FFFF0000'; // Rojo
      case 'warn':
      case 'warning':
        return 'FFFFA500'; // Naranja
      case 'info':
        return 'FF0066CC'; // Azul
      default:
        return 'FF808080'; // Gris
    }
  }

  private static getSeverityColorForPDF(severity: string): string {
    switch (severity.toLowerCase()) {
      case 'critical':
        return '#FF0000'; // Rojo
      case 'warn':
      case 'warning':
        return '#FFA500'; // Naranja
      case 'info':
        return '#0066CC'; // Azul
      default:
        return '#808080'; // Gris
    }
  }
}

