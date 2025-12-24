// src/api/v1/services/commissions-export-pdf.service.ts
import PDFDocument from 'pdfkit';
import path from 'path';
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
          autoFirstPage: false, // ✅ CRÍTICO: Evitar página en blanco inicial
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

    // Ajuste de anchos (Letter Landscape ~792pt, margins 50 => ~692pt disponibles)
    const colWidths = isDimensionVentana
      ? [80, 140, 95, 60, 95, 95, 95] // Total: 660
      : [80, 140, 95, 60, 95, 95, 95];

    // Dibujar encabezado
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

    // Datos
    doc.fontSize(8).font('Helvetica');

    let rowIndex = 0;
    for (const item of payload.summary) {
      const date = this.formatDate(item.date);
      
      // ✅ NUEVO: Detectar si hay agrupación (byVentana o byVendedor presente)
      const hasGrouping = (isDimensionVentana && item.byVentana && item.byVentana.length > 0) ||
                          (!isDimensionVentana && item.byVendedor && item.byVendedor.length > 0);

      if (hasGrouping) {
        // ✅ NUEVO: Fila de total consolidado con "TODOS" y formato destacado
        const totalEntity = 'TODOS';
        
        const totalValues = isDimensionVentana
          ? [
            date,
            totalEntity,
            this.formatCurrency(item.totalSales),
            item.totalTickets.toString(),
            this.formatCurrency(item.commissionListero || 0),
            this.formatCurrency(item.commissionVendedor || 0),
            this.formatCurrency((item.commissionListero || 0) - (item.commissionVendedor || 0)),
          ]
          : [
            date,
            totalEntity,
            this.formatCurrency(item.totalSales),
            item.totalTickets.toString(),
            this.formatCurrency(item.commissionVendedor || 0),
            this.formatCurrency(item.commissionListero || 0),
            this.formatCurrency(item.net || 0),
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

        // ✅ NUEVO: Formato destacado para fila de total (negrita, fondo gris claro)
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

        // ✅ NUEVO: Filas de desglose por entidad con indentación visual
        if (isDimensionVentana && item.byVentana) {
          for (const breakdown of item.byVentana) {
            const breakdownEntity = `  - ${breakdown.ventanaName}`;
            
            const breakdownValues = [
              date,
              breakdownEntity,
              this.formatCurrency(breakdown.totalSales),
              breakdown.totalTickets.toString(),
              this.formatCurrency(breakdown.commissionListero || 0),
              this.formatCurrency(breakdown.commissionVendedor || 0),
              this.formatCurrency((breakdown.commissionListero || 0) - (breakdown.commissionVendedor || 0)),
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
              breakdown.totalTickets.toString(),
              this.formatCurrency(breakdown.commissionVendedor || 0),
              this.formatCurrency(breakdown.commissionListero || 0),
              this.formatCurrency(breakdown.net || 0),
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
        // ✅ Comportamiento normal cuando NO hay agrupación
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

        // ✅ CRÍTICO: Calcular altura dinámica basada en TODAS las columnas
        let maxCellHeight = 0;
        values.forEach((val, i) => {
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

        // Fondo alternado
        if (rowIndex % 2 === 1) {
          doc.fillColor('#F0F0F0').rect(startX, y, pageWidth, rowHeight).fill();
          doc.fillColor('black');
        }

        x = startX;

        values.forEach((value, i) => {
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

        y += rowHeight;
        rowIndex++;
      }
    }

    // Fila de totales
    // Verificar espacio para totales
    if (y > doc.page.height - 50) {
      doc.addPage();
      y = 50;
    }

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
      const date = this.formatDate(item.date);
      const entity = isDimensionVentana ? (item.ventanaName || '-') : (item.vendedorName || '-');
      const loteria = item.loteriaName.substring(0, 15);
      const sorteo = item.sorteoTime;
      const multiplier = item.multiplierName.substring(0, 18);

      // ✅ CRÍTICO: Calcular altura dinámica
      // Considerar columnas de texto largo: Entity (1), Loteria (2), Multiplier (4)
      const h1 = doc.heightOfString(entity, { width: colWidths[1] - 6 });
      const h2 = doc.heightOfString(loteria, { width: colWidths[2] - 6 });
      const h4 = doc.heightOfString(multiplier, { width: colWidths[4] - 6 });

      const maxTextHeight = Math.max(h1, h2, h4);
      const rowHeight = Math.max(16, maxTextHeight + 6);

      // Verificar si necesitamos nueva página
      if (y + rowHeight > doc.page.height - 50) {
        doc.addPage();
        y = 50;

        // Redibujar encabezado
        doc.fontSize(8).font('Helvetica-Bold');
        doc.fillColor('#4472C4').rect(startX, y, pageWidth, 18).fill();
        doc.fillColor('white');

        x = startX;
        headers.forEach((header, i) => {
          doc.text(header, x + 3, y + 4, { width: colWidths[i] - 6, align: 'center' });
          x += colWidths[i];
        });

        y += 18;
        doc.fillColor('black');
        doc.fontSize(7).font('Helvetica');
      }

      // Fondo alternado
      const rowIndex = (payload.breakdown || []).indexOf(item);
      if (rowIndex % 2 === 1) {
        doc.fillColor('#F0F0F0').rect(startX, y, pageWidth, rowHeight).fill();
        doc.fillColor('black');
      }

      x = startX;

      const values = [
        date,
        entity,
        loteria,
        sorteo,
        multiplier,
        this.formatCurrency(item.totalSales),
        this.formatCurrency(item.commission),
        item.commissionPercent.toFixed(2) + '%',
        item.ticketsCount.toString(),
      ];

      values.forEach((value, i) => {
        const align = i >= 5 ? 'right' : 'left';
        // Centrar verticalmente
        const cellHeight = doc.heightOfString(value, { width: colWidths[i] - 6 });
        const topPadding = (rowHeight - cellHeight) / 2;

        doc.text(value, x + 3, y + topPadding, { width: colWidths[i] - 6, align });
        x += colWidths[i];
      });

      y += rowHeight;
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
      // Calcular altura dinámica del contenido
      const descHeight = doc.heightOfString(warning.description, { width: doc.page.width - 120 });
      const boxHeight = Math.max(40, descHeight + 30);

      // Verificar si necesitamos nueva página
      if (y + boxHeight > doc.page.height - 50) {
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

      doc.fillColor(bgColor).rect(50, y, doc.page.width - 100, boxHeight).fill();
      doc.fillColor('black');

      doc.font('Helvetica-Bold').text(`${this.getWarningTypeLabel(warning.type)} (${warning.severity.toUpperCase()})`, 60, y + 5);
      doc.font('Helvetica').text(`${warning.description}`, 60, y + 18, { width: doc.page.width - 120 });
      doc.text(`Afecta a: ${warning.affectedEntity}`, 60, y + 18 + descHeight + 5);

      y += boxHeight + 10;
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
        const entity = policy.entityName;
        const loteria = rule.loteriaName;

        // ✅ CRÍTICO: Calcular altura dinámica
        const h1 = doc.heightOfString(entity, { width: colWidths[0] - 10 });
        const h2 = doc.heightOfString(loteria, { width: colWidths[1] - 10 });
        const rowHeight = Math.max(18, h1 + 8, h2 + 8);

        // Verificar si necesitamos nueva página
        if (y + rowHeight > doc.page.height - 50) {
          doc.addPage();
          y = 50;

          // Redibujar encabezado
          doc.fontSize(9).font('Helvetica-Bold');
          doc.fillColor('#4472C4').rect(startX, y, pageWidth, 20).fill();
          doc.fillColor('white');

          x = startX;
          headers.forEach((header, i) => {
            doc.text(header, x + 5, y + 5, { width: colWidths[i] - 10, align: 'center' });
            x += colWidths[i];
          });

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
        const values = [
          entity,
          loteria,
          rule.betType,
          rule.multiplierRange,
          rule.percent.toFixed(2) + '%',
        ];

        values.forEach((value, i) => {
          const align = i === 4 ? 'right' : 'left';
          // Centrar verticalmente
          const cellHeight = doc.heightOfString(value, { width: colWidths[i] - 10 });
          const topPadding = (rowHeight - cellHeight) / 2;

          doc.text(value, x + 5, y + topPadding, { width: colWidths[i] - 10, align });
          x += colWidths[i];
        });

        y += rowHeight;
        rowIndex++;
      }
    }
  }

  /**
   * Agrega pie de página
   */
  private static addFooter(doc: PDFKit.PDFDocument, payload: CommissionExportPayload): void {
    const pages = doc.bufferedPageRange();
    const totalPages = pages.count;

    for (let i = 0; i < totalPages; i++) {
      const pageIndex = pages.start + i;
      doc.switchToPage(pageIndex);

      // ✅ CRÍTICO: Desactivar márgenes temporalmente para escribir en el pie de página sin generar nueva hoja
      const oldMargins = doc.page.margins;
      doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };

      doc.fontSize(8).font('Helvetica');
      doc.text(
        `Página ${i + 1} de ${totalPages}`,
        50,
        doc.page.height - 30,
        { align: 'center', width: doc.page.width - 100 }
      );

      doc.text(
        'Generado por Sistema de Bancas',
        50,
        doc.page.height - 20,
        { align: 'center', width: doc.page.width - 100 }
      );

      // Restaurar márgenes
      doc.page.margins = oldMargins;
    }
  }

  /**
   * Formatea fecha de YYYY-MM-DD a DD/MM/YYYY
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
    if (value < 0) {
      return `-${Math.abs(value).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
    }
    return value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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
