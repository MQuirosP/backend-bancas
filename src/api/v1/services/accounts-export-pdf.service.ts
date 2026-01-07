// src/api/v1/services/accounts-export-pdf.service.ts
import PDFDocument from 'pdfkit';
import path from 'path';
import { AccountStatementExportPayload } from '../types/accounts-export.types';

/**
 * Servicio para exportar estados de cuenta a PDF
 */
export class AccountsExportPdfService {
  /**
   * Genera PDF
   */
  static async generate(payload: AccountStatementExportPayload): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'LETTER',
          layout: 'landscape',
          margins: { top: 50, bottom: 50, left: 50, right: 50 },
          autoFirstPage: false, //  CRÍTICO: Evitar página en blanco inicial
        });

        // Registrar fuentes personalizadas para soportar ₡
        doc.registerFont('Helvetica', path.join(process.cwd(), 'src/assets/fonts/Regular.ttf'));
        doc.registerFont('Helvetica-Bold', path.join(process.cwd(), 'src/assets/fonts/Bold.ttf'));

        const chunks: Buffer[] = [];

        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // Agregar primera página manualmente
        doc.addPage();

        // Encabezado del documento
        this.addHeader(doc, payload);

        // Tabla de resumen
        this.addSummaryTable(doc, payload);

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
  private static addHeader(doc: PDFKit.PDFDocument, payload: AccountStatementExportPayload): void {
    const isDimensionVentana = payload.metadata.filters.dimension === 'ventana';

    // Título
    doc.fontSize(18).font('Helvetica-Bold').text('Estado de Cuenta', { align: 'center' });
    doc.moveDown(0.5);

    // Metadata
    doc.fontSize(10).font('Helvetica');
    doc.text(`Generado: ${this.formatDateTime(payload.metadata.generatedAt)} (GMT-6)`, {
      align: 'center',
    });
    doc.text(
      `Período: ${this.formatDate(payload.metadata.startDate)} - ${this.formatDate(payload.metadata.endDate)}`,
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
  private static addSummaryTable(
    doc: PDFKit.PDFDocument,
    payload: AccountStatementExportPayload
  ): void {
    const isDimensionVentana = payload.metadata.filters.dimension === 'ventana';
    const pageWidth = doc.page.width - 100; // Márgenes
    const startX = 50;
    let y = doc.y;

    // Encabezados
    const headers = isDimensionVentana
      ? ['Fecha', 'Listero', 'Ventas', 'Premios', 'Com. List.', 'Com. Vend.', 'Balance', 'Saldo']
      : ['Fecha', 'Vendedor', 'Ventas', 'Premios', 'Com. Vend.', 'Com. List.', 'Balance', 'Saldo'];

    // Ajuste de anchos para llenar mejor la página (Letter Landscape ~792pt, margins 50 => ~692pt disponibles)
    // Aumentar Fecha (0) a 90, Reducir Entidad (1) a 120
    const colWidths = [90, 120, 80, 80, 75, 75, 85, 85]; // Total: 690

    // Dibujar encabezado
    doc.fontSize(9).font('Helvetica-Bold');
    doc.fillColor('#4472C4').rect(startX, y, pageWidth, 20).fill();
    doc.fillColor('white');

    let x = startX;
    headers.forEach((header, i) => {
      const align = i >= 2 ? 'right' : 'left'; // Alinear encabezados numéricos a la derecha
      doc.text(header, x + 5, y + 5, { width: colWidths[i] - 10, align });
      x += colWidths[i];
    });

    y += 20;
    doc.fillColor('black');

    // Datos
    doc.fontSize(8).font('Helvetica');

    let rowIndex = 0;
    for (const item of payload.statements) {
      const date = this.formatDate(item.date);
      
      //  NUEVO: Detectar si hay agrupación (byVentana o byVendedor presente)
      const hasGrouping = (isDimensionVentana && item.byVentana && item.byVentana.length > 0) ||
                          (!isDimensionVentana && item.byVendedor && item.byVendedor.length > 0);

      if (hasGrouping) {
        //  NUEVO: Fila de total consolidado con "TODOS" y formato destacado
        const totalEntity = 'TODOS';
        
        const totalValues = isDimensionVentana
          ? [
            date,
            totalEntity,
            this.formatCurrency(item.totalSales),
            this.formatCurrency(item.totalPayouts),
            this.formatCurrency(item.listeroCommission),
            this.formatCurrency(item.vendedorCommission),
            this.formatCurrency(item.balance),
            this.formatCurrency(item.remainingBalance),
          ]
          : [
            date,
            totalEntity,
            this.formatCurrency(item.totalSales),
            this.formatCurrency(item.totalPayouts),
            this.formatCurrency(item.vendedorCommission),
            this.formatCurrency(item.listeroCommission),
            this.formatCurrency(item.balance),
            this.formatCurrency(item.remainingBalance),
          ];

        // Calcular altura dinámica
        let maxCellHeight = 0;
        totalValues.forEach((val, i) => {
          const h = doc.heightOfString(val, { width: colWidths[i] - 10 });
          if (h > maxCellHeight) maxCellHeight = h;
        });
        const rowHeight = Math.max(18, maxCellHeight + 8);

        // Verificar si necesitamos nueva página
        if (y + rowHeight > doc.page.height - 50) {
          doc.addPage();
          y = 50;
          this.redrawHeader(doc, headers, colWidths, startX, y, pageWidth);
          y += 20;
          doc.fillColor('black');
          doc.fontSize(8).font('Helvetica');
        }

        //  NUEVO: Formato destacado para fila de total (negrita, fondo gris claro)
        doc.fillColor('#D3D3D3').rect(startX, y, pageWidth, rowHeight).fill();
        doc.fillColor('black');
        doc.font('Helvetica-Bold');

        x = startX;
        totalValues.forEach((value, i) => {
          const align = i >= 2 ? 'right' : 'left';
          const cellHeight = doc.heightOfString(value, { width: colWidths[i] - 10 });
          const topPadding = (rowHeight - cellHeight) / 2;

          if (i >= 2 && typeof value === 'string' && value.startsWith('-')) {
            doc.fillColor('red');
            doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
            doc.fillColor('black');
          } else {
            doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
          }
          x += colWidths[i];
        });

        doc.font('Helvetica'); // Volver a fuente normal
        y += rowHeight;
        rowIndex++;

        //  NUEVO: Filas de desglose por entidad con indentación visual
        if (isDimensionVentana && item.byVentana) {
          for (const breakdown of item.byVentana) {
            const breakdownEntity = `  - ${breakdown.ventanaName}`;
            
            const breakdownValues = [
              date,
              breakdownEntity,
              this.formatCurrency(breakdown.totalSales),
              this.formatCurrency(breakdown.totalPayouts),
              this.formatCurrency(breakdown.listeroCommission),
              this.formatCurrency(breakdown.vendedorCommission),
              this.formatCurrency(breakdown.balance),
              this.formatCurrency(breakdown.remainingBalance),
            ];

            // Calcular altura dinámica
            maxCellHeight = 0;
            breakdownValues.forEach((val, i) => {
              const h = doc.heightOfString(val, { width: colWidths[i] - 10 });
              if (h > maxCellHeight) maxCellHeight = h;
            });
            const breakdownRowHeight = Math.max(18, maxCellHeight + 8);

            // Verificar si necesitamos nueva página
            if (y + breakdownRowHeight > doc.page.height - 50) {
              doc.addPage();
              y = 50;
              this.redrawHeader(doc, headers, colWidths, startX, y, pageWidth);
              y += 20;
              doc.fillColor('black');
              doc.fontSize(8).font('Helvetica');
            }

            // Fondo alternado
            if (rowIndex % 2 === 1) {
              doc.fillColor('#F0F0F0').rect(startX, y, pageWidth, breakdownRowHeight).fill();
              doc.fillColor('black');
            }

            x = startX;
            breakdownValues.forEach((value, i) => {
              const align = i >= 2 ? 'right' : 'left';
              const cellHeight = doc.heightOfString(value, { width: colWidths[i] - 10 });
              const topPadding = (breakdownRowHeight - cellHeight) / 2;

              if (i >= 2 && typeof value === 'string' && value.startsWith('-')) {
                doc.fillColor('red');
                doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
                doc.fillColor('black');
              } else {
                doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
              }
              x += colWidths[i];
            });

            y += breakdownRowHeight;
            rowIndex++;
          }
        } else if (!isDimensionVentana && item.byVendedor) {
          for (const breakdown of item.byVendedor) {
            const breakdownEntity = `  - ${breakdown.vendedorName}`;
            
            const breakdownValues = [
              date,
              breakdownEntity,
              this.formatCurrency(breakdown.totalSales),
              this.formatCurrency(breakdown.totalPayouts),
              this.formatCurrency(breakdown.vendedorCommission),
              this.formatCurrency(breakdown.listeroCommission),
              this.formatCurrency(breakdown.balance),
              this.formatCurrency(breakdown.remainingBalance),
            ];

            // Calcular altura dinámica
            let maxCellHeight = 0;
            breakdownValues.forEach((val, i) => {
              const h = doc.heightOfString(val, { width: colWidths[i] - 10 });
              if (h > maxCellHeight) maxCellHeight = h;
            });
            const breakdownRowHeight = Math.max(18, maxCellHeight + 8);

            // Verificar si necesitamos nueva página
            if (y + breakdownRowHeight > doc.page.height - 50) {
              doc.addPage();
              y = 50;
              this.redrawHeader(doc, headers, colWidths, startX, y, pageWidth);
              y += 20;
              doc.fillColor('black');
              doc.fontSize(8).font('Helvetica');
            }

            // Fondo alternado
            if (rowIndex % 2 === 1) {
              doc.fillColor('#F0F0F0').rect(startX, y, pageWidth, breakdownRowHeight).fill();
              doc.fillColor('black');
            }

            x = startX;
            breakdownValues.forEach((value, i) => {
              const align = i >= 2 ? 'right' : 'left';
              const cellHeight = doc.heightOfString(value, { width: colWidths[i] - 10 });
              const topPadding = (breakdownRowHeight - cellHeight) / 2;

              if (i >= 2 && typeof value === 'string' && value.startsWith('-')) {
                doc.fillColor('red');
                doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
                doc.fillColor('black');
              } else {
                doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
              }
              x += colWidths[i];
            });

            y += breakdownRowHeight;
            rowIndex++;
          }
        }
      } else {
        //  Comportamiento normal cuando NO hay agrupación
        const entity = isDimensionVentana
          ? (item.ventanaName || '-')
          : (item.vendedorName || '-');

        const values = isDimensionVentana
          ? [
            date,
            entity,
            this.formatCurrency(item.totalSales),
            this.formatCurrency(item.totalPayouts),
            this.formatCurrency(item.listeroCommission),
            this.formatCurrency(item.vendedorCommission),
            this.formatCurrency(item.balance),
            this.formatCurrency(item.remainingBalance),
          ]
          : [
            date,
            entity,
            this.formatCurrency(item.totalSales),
            this.formatCurrency(item.totalPayouts),
            this.formatCurrency(item.vendedorCommission),
            this.formatCurrency(item.listeroCommission),
            this.formatCurrency(item.balance),
            this.formatCurrency(item.remainingBalance),
          ];

        //  CRÍTICO: Calcular altura dinámica basada en TODAS las columnas
        let maxCellHeight = 0;
        values.forEach((val, i) => {
          const h = doc.heightOfString(val, { width: colWidths[i] - 10 });
          if (h > maxCellHeight) maxCellHeight = h;
        });

        const rowHeight = Math.max(18, maxCellHeight + 8); // Mínimo 18px, o altura máxima + padding

        // Verificar si necesitamos nueva página
        if (y + rowHeight > doc.page.height - 50) {
          doc.addPage();
          y = 50;
          this.redrawHeader(doc, headers, colWidths, startX, y, pageWidth);
          y += 20;
          doc.fillColor('black');
          doc.fontSize(8).font('Helvetica');
        }

        // Fondo alternado
        if (rowIndex % 2 === 1) {
          doc.fillColor('#F0F0F0').rect(startX, y, pageWidth, rowHeight).fill();
          doc.fillColor('black');
        }

        x = startX;

        values.forEach((value, i) => {
          const align = i >= 2 ? 'right' : 'left';
          // Centrar verticalmente el texto
          const cellHeight = doc.heightOfString(value, { width: colWidths[i] - 10 });
          const topPadding = (rowHeight - cellHeight) / 2;

          //  CRÍTICO: Números negativos en rojo
          if (i >= 2 && typeof value === 'string' && value.startsWith('-')) {
            doc.fillColor('red');
            doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
            doc.fillColor('black');
          } else {
            doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
          }

          x += colWidths[i];
        });

        y += rowHeight;
        rowIndex++;
      }
    }

    // Fila de totales del período
    x = startX;
    const totalValues = isDimensionVentana
      ? [
        'TOTAL PERÍODO',
        '-',
        this.formatCurrency(payload.totals.totalSales),
        this.formatCurrency(payload.totals.totalPayouts),
        this.formatCurrency(payload.totals.totalListeroCommission),
        this.formatCurrency(payload.totals.totalVendedorCommission),
        this.formatCurrency(payload.totals.totalBalance),
        this.formatCurrency(payload.totals.totalRemainingBalance),
      ]
      : [
        'TOTAL PERÍODO',
        '-',
        this.formatCurrency(payload.totals.totalSales),
        this.formatCurrency(payload.totals.totalPayouts),
        this.formatCurrency(payload.totals.totalVendedorCommission),
        this.formatCurrency(payload.totals.totalListeroCommission),
        this.formatCurrency(payload.totals.totalBalance),
        this.formatCurrency(payload.totals.totalRemainingBalance),
      ];

    // Calcular altura dinámica para totales
    let maxTotalHeight = 0;
    totalValues.forEach((val, i) => {
      const h = doc.heightOfString(val, { width: colWidths[i] - 10 });
      if (h > maxTotalHeight) maxTotalHeight = h;
    });
    const totalRowHeight = Math.max(20, maxTotalHeight + 10);

    if (y + totalRowHeight > doc.page.height - 50) {
      doc.addPage();
      y = 50;
    }

    doc.fontSize(9).font('Helvetica-Bold');
    doc.fillColor('#203764').rect(startX, y, pageWidth, totalRowHeight).fill();
    doc.fillColor('white');

    totalValues.forEach((value, i) => {
      const align = i >= 2 ? 'right' : 'left';
      // Centrar verticalmente
      const cellHeight = doc.heightOfString(value, { width: colWidths[i] - 10 });
      const topPadding = (totalRowHeight - cellHeight) / 2;

      //  CRÍTICO: Números negativos en rojo (aunque font es blanco, usar paréntesis)
      if (i >= 2 && typeof value === 'string' && value.startsWith('-')) {
        // Para totales con fondo oscuro y texto blanco, usar paréntesis
        const absValue = value.substring(1); // Quitar el signo menos
        doc.text(`(${absValue})`, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
      } else {
        doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
      }

      x += colWidths[i];
    });

    y += totalRowHeight;
    doc.fillColor('black');

    // Fila de Saldo a Hoy (acumulado del mes)
    if (payload.monthlyAccumulated) {
      y += 5; // Espacio

      x = startX;
      const accValues = isDimensionVentana
        ? [
          'SALDO A HOY (MES)',
          '-',
          this.formatCurrency(payload.monthlyAccumulated.totalSales),
          this.formatCurrency(payload.monthlyAccumulated.totalPayouts),
          this.formatCurrency(payload.monthlyAccumulated.totalListeroCommission),
          this.formatCurrency(payload.monthlyAccumulated.totalVendedorCommission),
          this.formatCurrency(payload.monthlyAccumulated.totalBalance),
          this.formatCurrency(payload.monthlyAccumulated.totalRemainingBalance),
        ]
        : [
          'SALDO A HOY (MES)',
          '-',
          this.formatCurrency(payload.monthlyAccumulated.totalSales),
          this.formatCurrency(payload.monthlyAccumulated.totalPayouts),
          this.formatCurrency(payload.monthlyAccumulated.totalVendedorCommission),
          this.formatCurrency(payload.monthlyAccumulated.totalListeroCommission),
          this.formatCurrency(payload.monthlyAccumulated.totalBalance),
          this.formatCurrency(payload.monthlyAccumulated.totalRemainingBalance),
        ];

      // Calcular altura dinámica para acumulado
      let maxAccHeight = 0;
      accValues.forEach((val, i) => {
        const h = doc.heightOfString(val, { width: colWidths[i] - 10 });
        if (h > maxAccHeight) maxAccHeight = h;
      });
      const accRowHeight = Math.max(20, maxAccHeight + 10);

      if (y + accRowHeight > doc.page.height - 50) {
        doc.addPage();
        y = 50;
      }

      doc.fontSize(9).font('Helvetica-Bold');
      doc.fillColor('#D9E1F2').rect(startX, y, pageWidth, accRowHeight).fill();
      doc.fillColor('black');

      accValues.forEach((value, i) => {
        const align = i >= 2 ? 'right' : 'left';
        // Centrar verticalmente
        const cellHeight = doc.heightOfString(value, { width: colWidths[i] - 10 });
        const topPadding = (accRowHeight - cellHeight) / 2;

        //  CRÍTICO: Números negativos en rojo
        if (i >= 2 && typeof value === 'string' && value.startsWith('-')) {
          doc.fillColor('red');
          doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
          doc.fillColor('black');
        } else {
          doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
        }

        x += colWidths[i];
      });

      doc.fillColor('black');
    }
  }

  /**
   * Agrega pie de página
   */
  private static addFooter(doc: PDFKit.PDFDocument, payload: AccountStatementExportPayload): void {
    const pages = doc.bufferedPageRange();
    const totalPages = pages.count;

    for (let i = 0; i < totalPages; i++) {
      const pageIndex = pages.start + i;
      doc.switchToPage(pageIndex);

      //  CRÍTICO: Desactivar márgenes temporalmente para escribir en el pie de página sin generar nueva hoja
      const oldMargins = doc.page.margins;
      doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };

      doc.fontSize(8).font('Helvetica');
      doc.text(`Página ${i + 1} de ${totalPages}`, 50, doc.page.height - 30, {
        align: 'center',
        width: doc.page.width - 100,
      });

      doc.text('Generado por Sistema de Bancas', 50, doc.page.height - 20, {
        align: 'center',
        width: doc.page.width - 100,
      });

      // Restaurar márgenes
      doc.page.margins = oldMargins;
    }
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

  /**
   * Formatea número como moneda
   *  CRÍTICO: Números negativos con paréntesis y signo de menos
   */
  /**
   * Redibuja el encabezado de la tabla en una nueva página
   */
  private static redrawHeader(
    doc: PDFKit.PDFDocument,
    headers: string[],
    colWidths: number[],
    startX: number,
    y: number,
    pageWidth: number
  ): void {
    doc.fontSize(9).font('Helvetica-Bold');
    doc.fillColor('#4472C4').rect(startX, y, pageWidth, 20).fill();
    doc.fillColor('white');

    let x = startX;
    headers.forEach((header, i) => {
      const align = i >= 2 ? 'right' : 'left';
      doc.text(header, x + 5, y + 5, { width: colWidths[i] - 10, align });
      x += colWidths[i];
    });

    doc.fillColor('black');
  }

  private static formatCurrency(value: number): string {
    if (value < 0) {
      return `-(${Math.abs(value).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')})`;
    }
    return value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
}
