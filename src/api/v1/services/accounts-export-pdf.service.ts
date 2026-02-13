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
          autoFirstPage: false,
        });

        doc.registerFont('Helvetica', path.join(process.cwd(), 'src/assets/fonts/Regular.ttf'));
        doc.registerFont('Helvetica-Bold', path.join(process.cwd(), 'src/assets/fonts/Bold.ttf'));

        const chunks: Buffer[] = [];

        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        doc.addPage();
        this.addHeader(doc, payload);
        this.addSummaryTable(doc, payload);
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

    doc.fontSize(18).font('Helvetica-Bold').text('Estado de Cuenta', { align: 'center' });
    doc.moveDown(0.5);

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
    const pageWidth = doc.page.width - 100;
    const startX = 50;
    let y = doc.y;

    const headers = isDimensionVentana
      ? ['Fecha', 'Listero', 'Ventas', 'Premios', 'Com. List.', 'Com. Vend.', 'Balance', 'Saldo']
      : ['Fecha', 'Vendedor', 'Ventas', 'Premios', 'Com. Vend.', 'Com. List.', 'Balance', 'Saldo'];

    const colWidths = [90, 120, 80, 80, 75, 75, 85, 85];

    doc.fontSize(9).font('Helvetica-Bold');
    doc.fillColor('#4472C4').rect(startX, y, pageWidth, 20).fill();
    doc.fillColor('white');

    let x = startX;
    headers.forEach((header, i) => {
      const align = i >= 2 ? 'right' : 'left';
      doc.text(header, x + 5, y + 5, { width: colWidths[i] - 10, align });
      x += colWidths[i];
    });

    y += 20;
    doc.fillColor('black');

    doc.fontSize(8).font('Helvetica');

    let rowIndex = 0;
    for (const item of payload.statements) {
      const date = this.formatDate(item.date);
      const hasGrouping = (isDimensionVentana && item.byVentana && item.byVentana.length > 0) ||
        (!isDimensionVentana && item.byVendedor && item.byVendedor.length > 0);

      if (hasGrouping) {
        const totalEntity = 'TODOS';

        const totalRowValues = isDimensionVentana
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

        let maxCellHeight = 0;
        totalRowValues.forEach((val, i) => {
          const h = doc.heightOfString(val, { width: colWidths[i] - 10 });
          if (h > maxCellHeight) maxCellHeight = h;
        });
        const rowHeight = Math.max(18, maxCellHeight + 8);

        if (y + rowHeight > doc.page.height - 50) {
          doc.addPage();
          y = 50;
          this.redrawHeader(doc, headers, colWidths, startX, y, pageWidth);
          y += 20;
          doc.fillColor('black');
          doc.fontSize(8).font('Helvetica');
        }

        doc.fillColor('#D3D3D3').rect(startX, y, pageWidth, rowHeight).fill();
        doc.fillColor('black');
        doc.font('Helvetica-Bold');

        x = startX;
        totalRowValues.forEach((value, i) => {
          const align = i >= 2 ? 'right' : 'left';
          const cellHeight = doc.heightOfString(value, { width: colWidths[i] - 10 });
          const topPadding = (rowHeight - cellHeight) / 2;

          if (i >= 2 && value.startsWith('-')) {
            doc.fillColor('red');
            doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
            doc.fillColor('black');
          } else {
            doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
          }
          x += colWidths[i];
        });

        doc.font('Helvetica');
        y += rowHeight;
        rowIndex++;

        if (item.bySorteo && item.bySorteo.length > 0) {
          const res = this.addInterleavedRows(doc, item.bySorteo, y, startX, colWidths, false);
          y = res.y;
        }

        if (isDimensionVentana && item.byVentana) {
          for (const breakdown of item.byVentana) {
            const breakdownEntity = `  - ${breakdown.ventanaName}`;
            const values = [
              date,
              breakdownEntity,
              this.formatCurrency(breakdown.totalSales),
              this.formatCurrency(breakdown.totalPayouts),
              this.formatCurrency(breakdown.listeroCommission),
              this.formatCurrency(breakdown.vendedorCommission),
              this.formatCurrency(breakdown.balance),
              this.formatCurrency(breakdown.remainingBalance),
            ];

            let bMaxH = 0;
            values.forEach((val, i) => {
              const h = doc.heightOfString(val, { width: colWidths[i] - 10 });
              if (h > bMaxH) bMaxH = h;
            });
            const bRowH = Math.max(18, bMaxH + 8);

            if (y + bRowH > doc.page.height - 50) {
              doc.addPage();
              y = 50;
              this.redrawHeader(doc, headers, colWidths, startX, y, pageWidth);
              y += 20;
              doc.fillColor('black');
              doc.fontSize(8).font('Helvetica');
            }

            if (rowIndex % 2 === 1) {
              doc.fillColor('#F0F0F0').rect(startX, y, pageWidth, bRowH).fill();
              doc.fillColor('black');
            }

            x = startX;
            values.forEach((value, i) => {
              const align = i >= 2 ? 'right' : 'left';
              const cellHeight = doc.heightOfString(value, { width: colWidths[i] - 10 });
              const topPadding = (bRowH - cellHeight) / 2;

              if (i >= 2 && value.startsWith('-')) {
                doc.fillColor('red');
                doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
                doc.fillColor('black');
              } else {
                doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
              }
              x += colWidths[i];
            });

            y += bRowH;
            rowIndex++;

            if (breakdown.bySorteo && breakdown.bySorteo.length > 0) {
              const res = this.addInterleavedRows(doc, breakdown.bySorteo, y, startX, colWidths, true);
              y = res.y;
            }
          }
        } else if (!isDimensionVentana && item.byVendedor) {
          for (const breakdown of item.byVendedor) {
            const breakdownEntity = `  - ${breakdown.vendedorName}`;
            const values = [
              date,
              breakdownEntity,
              this.formatCurrency(breakdown.totalSales),
              this.formatCurrency(breakdown.totalPayouts),
              this.formatCurrency(breakdown.vendedorCommission),
              this.formatCurrency(breakdown.listeroCommission),
              this.formatCurrency(breakdown.balance),
              this.formatCurrency(breakdown.remainingBalance),
            ];

            let bMaxH = 0;
            values.forEach((val, i) => {
              const h = doc.heightOfString(val, { width: colWidths[i] - 10 });
              if (h > bMaxH) bMaxH = h;
            });
            const bRowH = Math.max(18, bMaxH + 8);

            if (y + bRowH > doc.page.height - 50) {
              doc.addPage();
              y = 50;
              this.redrawHeader(doc, headers, colWidths, startX, y, pageWidth);
              y += 20;
              doc.fillColor('black');
              doc.fontSize(8).font('Helvetica');
            }

            if (rowIndex % 2 === 1) {
              doc.fillColor('#F0F0F0').rect(startX, y, pageWidth, bRowH).fill();
              doc.fillColor('black');
            }

            x = startX;
            values.forEach((value, i) => {
              const align = i >= 2 ? 'right' : 'left';
              const cellHeight = doc.heightOfString(value, { width: colWidths[i] - 10 });
              const topPadding = (bRowH - cellHeight) / 2;

              if (i >= 2 && value.startsWith('-')) {
                doc.fillColor('red');
                doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
                doc.fillColor('black');
              } else {
                doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
              }
              x += colWidths[i];
            });

            y += bRowH;
            rowIndex++;

            if (breakdown.bySorteo && breakdown.bySorteo.length > 0) {
              const res = this.addInterleavedRows(doc, breakdown.bySorteo, y, startX, colWidths, true);
              y = res.y;
            }
          }
        }
      } else {
        const entity = isDimensionVentana ? item.ventanaName || '-' : item.vendedorName || '-';
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

        let maxH = 0;
        values.forEach((val, i) => {
          const h = doc.heightOfString(val, { width: colWidths[i] - 10 });
          if (h > maxH) maxH = h;
        });
        const rH = Math.max(18, maxH + 8);

        if (y + rH > doc.page.height - 50) {
          doc.addPage();
          y = 50;
          this.redrawHeader(doc, headers, colWidths, startX, y, pageWidth);
          y += 20;
          doc.fillColor('black');
          doc.fontSize(8).font('Helvetica');
        }

        if (rowIndex % 2 === 1) {
          doc.fillColor('#F0F0F0').rect(startX, y, pageWidth, rH).fill();
          doc.fillColor('black');
        }

        x = startX;
        values.forEach((value, i) => {
          const align = i >= 2 ? 'right' : 'left';
          const cellHeight = doc.heightOfString(value, { width: colWidths[i] - 10 });
          const topPadding = (rH - cellHeight) / 2;

          if (i >= 2 && value.startsWith('-')) {
            doc.fillColor('red');
            doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
            doc.fillColor('black');
          } else {
            doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
          }
          x += colWidths[i];
        });

        y += rH;
        rowIndex++;

        if (item.bySorteo && item.bySorteo.length > 0) {
          const res = this.addInterleavedRows(doc, item.bySorteo, y, startX, colWidths, false);
          y = res.y;
        }
      }
    }

    // Totales del período
    x = startX;
    const totals = isDimensionVentana
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

    let maxTH = 0;
    totals.forEach((val, i) => {
      const h = doc.heightOfString(val, { width: colWidths[i] - 10 });
      if (h > maxTH) maxTH = h;
    });
    const tRH = Math.max(20, maxTH + 10);

    if (y + tRH > doc.page.height - 50) {
      doc.addPage();
      y = 50;
    }

    doc.fontSize(9).font('Helvetica-Bold');
    doc.fillColor('#203764').rect(startX, y, pageWidth, tRH).fill();
    doc.fillColor('white');

    totals.forEach((value, i) => {
      const align = i >= 2 ? 'right' : 'left';
      const cellHeight = doc.heightOfString(value, { width: colWidths[i] - 10 });
      const topPadding = (tRH - cellHeight) / 2;

      if (i >= 2 && value.startsWith('-')) {
        const absValue = value.substring(1);
        doc.text(`(${absValue})`, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
      } else {
        doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
      }
      x += colWidths[i];
    });

    y += tRH;
    doc.fillColor('black');

    // Saldo a Hoy
    if (payload.monthlyAccumulated) {
      y += 5;
      x = startX;
      const acc = isDimensionVentana
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

      let maxAH = 0;
      acc.forEach((val, i) => {
        const h = doc.heightOfString(val, { width: colWidths[i] - 10 });
        if (h > maxAH) maxAH = h;
      });
      const aRH = Math.max(20, maxAH + 10);

      if (y + aRH > doc.page.height - 50) {
        doc.addPage();
        y = 50;
      }

      doc.fontSize(9).font('Helvetica-Bold');
      doc.fillColor('#D9E1F2').rect(startX, y, pageWidth, aRH).fill();
      doc.fillColor('black');

      acc.forEach((value, i) => {
        const align = i >= 2 ? 'right' : 'left';
        const cellHeight = doc.heightOfString(value, { width: colWidths[i] - 10 });
        const topPadding = (aRH - cellHeight) / 2;

        if (i >= 2 && value.startsWith('-')) {
          doc.fillColor('red');
          doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
          doc.fillColor('black');
        } else {
          doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
        }
        x += colWidths[i];
      });
    }
  }

  private static addInterleavedRows(
    doc: PDFKit.PDFDocument,
    interleaved: any[],
    startY: number,
    startX: number,
    colWidths: number[],
    isNested: boolean
  ): { y: number } {
    let y = startY;
    const indent = isNested ? '    ' : '  ';
    doc.fontSize(7).font('Helvetica-Bold');
    doc.fillColor('#666666');

    for (const event of interleaved) {
      const isSorteo = !event.type || event.type === 'sorteo';
      const timeStr = event.time || '';

      let detailName = '';
      let salesStr = '';
      let payoutsStr = '';
      let balanceStr = this.formatCurrency(event.balance || 0);
      let listeroComStr = '';
      let vendedorComStr = '';
      let accumulatedStr = this.formatCurrency(event.accumulated || 0);

      if (isSorteo) {
        detailName = `${indent}${timeStr} ${event.loteriaName} - ${event.sorteoName}`;
        salesStr = this.formatCurrency(event.sales || 0);
        payoutsStr = this.formatCurrency(event.payouts || 0);
        listeroComStr = this.formatCurrency(event.listeroCommission || 0);
        vendedorComStr = this.formatCurrency(event.vendedorCommission || 0);
      } else {
        const typeLabel = event.type === 'payment' ? 'PAGO' : (event.type === 'collection' ? 'COBRO' : 'SALDO INI');
        detailName = `${indent}${timeStr} [${typeLabel}] ${event.sorteoName}${event.notes ? ' - ' + event.notes : ''}`;
        const amountStr = this.formatCurrency(event.amount || 0);
        if (event.type === 'payment') listeroComStr = amountStr;
        else if (event.type === 'collection') vendedorComStr = amountStr;
      }

      const values = ['', detailName, salesStr, payoutsStr, listeroComStr, vendedorComStr, balanceStr, accumulatedStr];

      let maxH = 0;
      values.forEach((val, i) => {
        const h = doc.heightOfString(val, { width: colWidths[i] - 10 });
        if (h > maxH) maxH = h;
      });
      const rH = Math.max(12, maxH + 4);

      if (y + rH > doc.page.height - 50) {
        doc.addPage();
        y = 50;
        doc.fontSize(7).font('Helvetica-Bold');
        doc.fillColor('#666666');
      }

      let x = startX;
      values.forEach((value, i) => {
        const align = i >= 2 ? 'right' : 'left';
        const cellHeight = doc.heightOfString(value, { width: colWidths[i] - 10 });
        const topPadding = (rH - cellHeight) / 2;

        if (i >= 2 && value.startsWith('-')) {
          doc.fillColor('red');
          doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
          doc.fillColor('#666666');
        } else {
          doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
        }
        x += colWidths[i];
      });
      y += rH;
    }

    doc.fillColor('black');
    return { y };
  }

  private static redrawHeader(doc: PDFKit.PDFDocument, headers: string[], colWidths: number[], startX: number, y: number, pageWidth: number): void {
    doc.fontSize(9).font('Helvetica-Bold');
    doc.fillColor('#4472C4').rect(startX, y, pageWidth, 20).fill();
    doc.fillColor('white');
    let x = startX;
    headers.forEach((h, i) => {
      const align = i >= 2 ? 'right' : 'left';
      doc.text(h, x + 5, y + 5, { width: colWidths[i] - 10, align });
      x += colWidths[i];
    });
    doc.fillColor('black');
  }

  private static addFooter(doc: PDFKit.PDFDocument, payload: AccountStatementExportPayload): void {
    const pages = doc.bufferedPageRange();
    const totalPages = pages.count;
    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(pages.start + i);
      const oldMargins = doc.page.margins;
      doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };
      doc.fontSize(8).font('Helvetica').text(`Página ${i + 1} de ${totalPages}`, 50, doc.page.height - 30, { align: 'center', width: doc.page.width - 100 });
      doc.text('Generado por Sistema de Bancas', 50, doc.page.height - 20, { align: 'center', width: doc.page.width - 100 });
      doc.page.margins = oldMargins;
    }
  }

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

  private static formatDateTime(date: Date): string {
    const d = new Date(date);
    const day = d.getDate().toString().padStart(2, '0');
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const year = d.getFullYear();
    const hours = d.getHours().toString().padStart(2, '0');
    const minutes = d.getMinutes().toString().padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  }

  private static formatCurrency(value: number): string {
    if (value < 0) return `-(${Math.abs(value).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')})`;
    return value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
}
