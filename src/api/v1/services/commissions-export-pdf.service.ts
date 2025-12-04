// src/api/v1/services/commissions-export-pdf.service.ts
import PDFDocument from 'pdfkit';
import { CommissionExportPayload } from '../types/commissions-export.types';

/**
 * Servicio para exportar comisiones a PDF
 */
export class CommissionsExportPdfService {
  /**
   * Genera PDF
   */
  static async generate(payload: CommissionExportPayload): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'LETTER',
          layout: 'landscape',
          margins: { top: 50, bottom: 50, left: 50, right: 50 },
        });

        const chunks: Buffer[] = [];

        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // Encabezado del documento
        this.addHeader(doc, payload);

        // Resumen principal
        this.addSummaryTable(doc, payload);

        // Breakdown (si está incluido)
        if (payload.breakdown && payload.breakdown.length > 0) {
          doc.addPage();
          this.addBreakdownTable(doc, payload);
        }

        // Advertencias (si están incluidas)
        if (payload.warnings && payload.warnings.length > 0) {
          doc.addPage();
          this.addWarningsSection(doc, payload);
        }

        // Políticas de comisión (si están incluidas)
        if (payload.policies && payload.policies.length > 0) {
          doc.addPage();
          this.addPoliciesTable(doc, payload);
        }

        // Pie de página
        this.addFooter(doc, payload);

        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Agrega encabezado del documento
   */
  private static addHeader(doc: PDFKit.PDFDocument, payload: CommissionExportPayload): void {
    const isDimensionVentana = payload.metadata.filters.dimension === 'ventana';

    // Título
    doc.fontSize(18).font('Helvetica-Bold').text('Reporte de Comisiones', { align: 'center' });
    doc.moveDown(0.5);

    // Metadata
    doc.fontSize(10).font('Helvetica');
    doc.text(`Generado: ${this.formatDateTime(payload.metadata.generatedAt)} (GMT-6)`, { align: 'center' });
    doc.text(
      `Período: ${this.formatDate(payload.metadata.dateRange.from)} - ${this.formatDate(payload.metadata.dateRange.to)}`,
      { align: 'center' }
    );
    doc.text(`Dimensión: ${isDimensionVentana ? 'Listeros' : 'Vendedores'}`, { align: 'center' });

    if (payload.metadata.filters.ventanaName) {
      doc.text(`Listero: ${payload.metadata.filters.ventanaName}`, { align: 'center' });
    }
    if (payload.metadata.filters.vendedorName) {
      doc.text(`Vendedor: ${payload.metadata.filters.vendedorName}`, { align: 'center' });
    }

    doc.moveDown(1);
  }

  /**
   * Agrega tabla de resumen
   */
  private static addSummaryTable(doc: PDFKit.PDFDocument, payload: CommissionExportPayload): void {
    const isDimensionVentana = payload.metadata.filters.dimension === 'ventana';
    const pageWidth = doc.page.width - 100; // Márgenes
    const startX = 50;
    let y = doc.y;

    // Encabezados
    const headers = isDimensionVentana
      ? ['Fecha', 'Listero', 'Ventas', 'Tickets', 'Com. Listero', 'Com. Vendedor', 'Ganancia']
      : ['Fecha', 'Vendedor', 'Ventas', 'Tickets', 'Com. Vendedor', 'Com. Listero', 'Ganancia'];

    const colWidths = isDimensionVentana
      ? [80, 120, 90, 60, 90, 90, 90]
      : [80, 120, 90, 60, 90, 90, 90];

    // Dibujar encabezado
    doc.fontSize(9).font('Helvetica-Bold');
    doc.fillColor('#4472C4').rect(startX, y, pageWidth, 20).fill();
    doc.fillColor('white');

    let x = startX;
    headers.forEach((header, i) => {
      doc.text(header, x + 5, y + 5, { width: colWidths[i] - 10, align: 'center' });
      x += colWidths[i];
    });

    y += 20;
    doc.fillColor('black');

    // Datos
    doc.fontSize(8).font('Helvetica');

    for (const item of payload.summary) {
      // Verificar si necesitamos nueva página
      if (y > doc.page.height - 100) {
        doc.addPage();
        y = 50;
      }

      // Fondo alternado
      const rowIndex = payload.summary.indexOf(item);
      if (rowIndex % 2 === 1) {
        doc.fillColor('#F0F0F0').rect(startX, y, pageWidth, 18).fill();
        doc.fillColor('black');
      }

      x = startX;
      const date = this.formatDate(item.date);
      const entity = isDimensionVentana ? item.ventanaName || '-' : item.vendedorName || '-';

      const values = isDimensionVentana
        ? [
            date,
            entity,
            this.formatCurrency(item.totalSales),
            item.totalTickets.toString(),
            this.formatCurrency(item.commissionListero || 0),
            this.formatCurrency(item.commissionVendedor || 0),
            this.formatCurrency((item.commissionListero || 0) - (item.commissionVendedor || 0)),
          ]
        : [
            date,
            entity,
            this.formatCurrency(item.totalSales),
            item.totalTickets.toString(),
            this.formatCurrency(item.commissionVendedor || 0),
            this.formatCurrency(item.commissionListero || 0),
            this.formatCurrency(item.net || 0),
          ];

      values.forEach((value, i) => {
        const align = i >= 2 ? 'right' : 'left';
        doc.text(value, x + 5, y + 4, { width: colWidths[i] - 10, align });
        x += colWidths[i];
      });

      y += 18;
    }

    // Fila de totales
    doc.fontSize(9).font('Helvetica-Bold');
    doc.fillColor('#203764').rect(startX, y, pageWidth, 20).fill();
    doc.fillColor('white');

    x = startX;
    const totalValues = isDimensionVentana
      ? [
          'TOTAL',
          '-',
          this.formatCurrency(payload.metadata.totals.totalSales),
          payload.metadata.totals.totalTickets.toString(),
          this.formatCurrency(payload.metadata.totals.commissionListero || 0),
          this.formatCurrency(payload.metadata.totals.commissionVendedor || 0),
          this.formatCurrency((payload.metadata.totals.commissionListero || 0) - (payload.metadata.totals.commissionVendedor || 0)),
        ]
      : [
          'TOTAL',
          '-',
          this.formatCurrency(payload.metadata.totals.totalSales),
          payload.metadata.totals.totalTickets.toString(),
          this.formatCurrency(payload.metadata.totals.commissionVendedor || 0),
          this.formatCurrency(payload.metadata.totals.commissionListero || 0),
          this.formatCurrency(payload.metadata.totals.net || 0),
        ];

    totalValues.forEach((value, i) => {
      const align = i >= 2 ? 'right' : 'left';
      doc.text(value, x + 5, y + 5, { width: colWidths[i] - 10, align });
      x += colWidths[i];
    });

    doc.fillColor('black');
  }

  /**
   * Agrega tabla de breakdown
   */
  private static addBreakdownTable(doc: PDFKit.PDFDocument, payload: CommissionExportPayload): void {
    const isDimensionVentana = payload.metadata.filters.dimension === 'ventana';
    const pageWidth = doc.page.width - 100;
    const startX = 50;
    let y = 50;

    // Título
    doc.fontSize(14).font('Helvetica-Bold').text('Desglose por Lotería, Sorteo y Multiplicador', startX, y);
    y += 30;

    // Encabezados
    const headers = isDimensionVentana
      ? ['Fecha', 'Listero', 'Lotería', 'Sorteo', 'Multiplicador', 'Ventas', 'Comisión', '%', 'Tickets']
      : ['Fecha', 'Vendedor', 'Lotería', 'Sorteo', 'Multiplicador', 'Ventas', 'Comisión', '%', 'Tickets'];

    const colWidths = [60, 80, 80, 60, 90, 80, 80, 50, 50];

    // Dibujar encabezado
    doc.fontSize(8).font('Helvetica-Bold');
    doc.fillColor('#4472C4').rect(startX, y, pageWidth, 18).fill();
    doc.fillColor('white');

    let x = startX;
    headers.forEach((header, i) => {
      doc.text(header, x + 3, y + 4, { width: colWidths[i] - 6, align: 'center' });
      x += colWidths[i];
    });

    y += 18;
    doc.fillColor('black');

    // Datos
    doc.fontSize(7).font('Helvetica');

    for (const item of payload.breakdown || []) {
      // Verificar si necesitamos nueva página
      if (y > doc.page.height - 100) {
        doc.addPage();
        y = 50;
      }

      // Fondo alternado
      const rowIndex = (payload.breakdown || []).indexOf(item);
      if (rowIndex % 2 === 1) {
        doc.fillColor('#F0F0F0').rect(startX, y, pageWidth, 16).fill();
        doc.fillColor('black');
      }

      x = startX;
      const date = this.formatDate(item.date);
      const entity = isDimensionVentana ? (item.ventanaName || '-') : (item.vendedorName || '-');

      const values = [
        date,
        entity,
        item.loteriaName.substring(0, 15), // Truncar si es muy largo
        item.sorteoTime,
        item.multiplierName.substring(0, 18),
        this.formatCurrency(item.totalSales),
        this.formatCurrency(item.commission),
        item.commissionPercent.toFixed(2) + '%',
        item.ticketsCount.toString(),
      ];

      values.forEach((value, i) => {
        const align = i >= 5 ? 'right' : 'left';
        doc.text(value, x + 3, y + 3, { width: colWidths[i] - 6, align });
        x += colWidths[i];
      });

      y += 16;
    }
  }

  /**
   * Agrega sección de advertencias
   */
  private static addWarningsSection(doc: PDFKit.PDFDocument, payload: CommissionExportPayload): void {
    let y = 50;

    // Título
    doc.fontSize(14).font('Helvetica-Bold').text('Advertencias y Notas', 50, y);
    y += 30;

    doc.fontSize(9).font('Helvetica');

    for (const warning of payload.warnings || []) {
      // Verificar si necesitamos nueva página
      if (y > doc.page.height - 150) {
        doc.addPage();
        y = 50;
      }

      // Color según severidad
      let bgColor = '#FFF9CC'; // Amarillo claro
      if (warning.severity === 'high') {
        bgColor = '#FFCCCC'; // Rojo claro
      } else if (warning.severity === 'medium') {
        bgColor = '#FFEDCC'; // Naranja claro
      }

      doc.fillColor(bgColor).rect(50, y, doc.page.width - 100, 40).fill();
      doc.fillColor('black');

      doc.font('Helvetica-Bold').text(`${this.getWarningTypeLabel(warning.type)} (${warning.severity.toUpperCase()})`, 60, y + 5);
      doc.font('Helvetica').text(`${warning.description}`, 60, y + 18);
      doc.text(`Afecta a: ${warning.affectedEntity}`, 60, y + 28);

      y += 50;
    }
  }

  /**
   * Agrega tabla de políticas de comisión
   */
  private static addPoliciesTable(doc: PDFKit.PDFDocument, payload: CommissionExportPayload): void {
    const isDimensionVentana = payload.metadata.filters.dimension === 'ventana';
    const pageWidth = doc.page.width - 100;
    const startX = 50;
    let y = 50;

    // Título
    doc.fontSize(14).font('Helvetica-Bold').text('Políticas de Comisión Configuradas', startX, y);
    doc.fontSize(10).font('Helvetica').text(`Dimensión: ${isDimensionVentana ? 'Listeros' : 'Vendedores'}`, startX, y + 20);
    y += 45;

    // Encabezados
    const entityLabel = isDimensionVentana ? 'Listero' : 'Vendedor';
    const headers = [entityLabel, 'Lotería', 'Tipo de Apuesta', 'Rango Multiplicador', '% Comisión'];
    const colWidths = [130, 130, 120, 140, 100];

    // Dibujar encabezado
    doc.fontSize(9).font('Helvetica-Bold');
    doc.fillColor('#4472C4').rect(startX, y, pageWidth, 20).fill();
    doc.fillColor('white');

    let x = startX;
    headers.forEach((header, i) => {
      doc.text(header, x + 5, y + 5, { width: colWidths[i] - 10, align: 'center' });
      x += colWidths[i];
    });

    y += 20;
    doc.fillColor('black');

    // Datos
    doc.fontSize(8).font('Helvetica');
    let rowIndex = 0;

    for (const policy of payload.policies || []) {
      for (const rule of policy.rules) {
        // Verificar si necesitamos nueva página
        if (y > doc.page.height - 100) {
          doc.addPage();
          y = 50;
        }

        // Fondo alternado
        if (rowIndex % 2 === 1) {
          doc.fillColor('#F0F0F0').rect(startX, y, pageWidth, 18).fill();
          doc.fillColor('black');
        }

        x = startX;
        const values = [
          policy.entityName,
          rule.loteriaName,
          rule.betType,
          rule.multiplierRange,
          rule.percent.toFixed(2) + '%',
        ];

        values.forEach((value, i) => {
          const align = i === 4 ? 'right' : 'left';
          doc.text(value, x + 5, y + 4, { width: colWidths[i] - 10, align });
          x += colWidths[i];
        });

        y += 18;
        rowIndex++;
      }
    }
  }

  /**
   * Agrega pie de página
   */
  private static addFooter(doc: PDFKit.PDFDocument, payload: CommissionExportPayload): void {
    const pages = doc.bufferedPageRange();

    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);

      doc.fontSize(8).font('Helvetica');
      doc.text(
        `Página ${i + 1} de ${pages.count}`,
        50,
        doc.page.height - 30,
        { align: 'center' }
      );

      doc.text(
        'Generado por Sistema de Bancas',
        50,
        doc.page.height - 20,
        { align: 'center' }
      );
    }
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
   * Formatea número como moneda
   */
  private static formatCurrency(value: number): string {
    return '₡' + value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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
