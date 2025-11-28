// src/api/v1/services/pdf-generator.service.ts
import PDFDocument from 'pdfkit';
import { Readable } from 'stream';
import logger from '../../../core/logger';

interface NumbersSummaryData {
  meta: {
    vendedorName?: string;
    ventanaName?: string;
    vendedorCode?: string;
    loteriaName?: string;
    sorteoDate?: Date;
    totalAmount: number;
    totalAmountByNumber: number;
    totalAmountByReventado: number;
  };
  numbers: Array<{
    number: string;
    amountByNumber: number;
    amountByReventado: number;
  }>;
}

/**
 * Formatea un número con separador de miles (punto) sin decimales
 * Ejemplo: 1500 -> "1.500", 125000 -> "125.000"
 */
function formatCurrency(amount: number): string {
  return Math.round(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * Genera un PDF con la lista de números 00-99
 */
export async function generateNumbersSummaryPDF(data: NumbersSummaryData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'LETTER', // 8.5" x 11"
        margins: {
          top: 15 * 2.83465, // 15mm
          bottom: 15 * 2.83465,
          left: 10 * 2.83465, // 10mm
          right: 10 * 2.83465,
        },
      });

      const buffers: Buffer[] = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfBuffer = Buffer.concat(buffers);
        resolve(pdfBuffer);
      });
      doc.on('error', reject);

      // Configuración de fuente (Courier = monoespaciada)
      doc.font('Courier');

      // 1. ENCABEZADO DEL REPORTE
      const userName = data.meta.vendedorName || data.meta.ventanaName || 'Usuario';
      const userCode = data.meta.vendedorCode ? ` (${data.meta.vendedorCode})` : '';
      const generatedAt = new Date().toLocaleString('es-CR', {
        timeZone: 'America/Costa_Rica',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      doc.fontSize(11).font('Courier-Bold');
      doc.text(`Usuario: ${userName}${userCode}`, { align: 'left' });
      doc.font('Courier');
      doc.fontSize(9);
      doc.text(`Fecha y hora de generación: ${generatedAt}`, { align: 'left' });

      if (data.meta.loteriaName) {
        doc.text(`Sorteo: ${data.meta.loteriaName}`, { align: 'left' });
      }
      if (data.meta.sorteoDate) {
        const sorteoDateStr = data.meta.sorteoDate.toLocaleString('es-CR', {
          timeZone: 'America/Costa_Rica',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
        doc.text(`Fecha del sorteo: ${sorteoDateStr}`, { align: 'left' });
      }

      doc.moveDown(0.5);

      // 2. LÍNEA SEPARADORA
      doc.text('--------------------------------------------------------', { align: 'center' });
      doc.moveDown(0.5);

      // 3. TOTALES GENERALES
      doc.fontSize(12).font('Courier-Bold');
      doc.text(`TOTAL GENERAL: ¢ ${formatCurrency(data.meta.totalAmount)}`, { align: 'center' });
      doc.fontSize(10).font('Courier');
      doc.text(`Normal: ¢ ${formatCurrency(data.meta.totalAmountByNumber)}`, { align: 'center' });
      doc.text(`Reventados: ¢ ${formatCurrency(data.meta.totalAmountByReventado)}`, { align: 'center' });
      doc.moveDown(0.5);

      // 4. LÍNEA SEPARADORA
      doc.text('--------------------------------------------------------', { align: 'center' });
      doc.moveDown(1);

      // 5. LISTADO DE NÚMEROS EN 4 COLUMNAS
      doc.fontSize(9).font('Courier');

      // Crear un mapa de números para acceso rápido
      const numbersMap = new Map<string, { amountByNumber: number; amountByReventado: number }>();
      data.numbers.forEach((item) => {
        numbersMap.set(item.number.padStart(2, '0'), {
          amountByNumber: item.amountByNumber,
          amountByReventado: item.amountByReventado,
        });
      });

      // Asegurar que todos los números 00-99 existan
      for (let i = 0; i <= 99; i++) {
        const num = i.toString().padStart(2, '0');
        if (!numbersMap.has(num)) {
          numbersMap.set(num, { amountByNumber: 0, amountByReventado: 0 });
        }
      }

      // Configuración de columnas
      const columnWidth = 130;
      const leftMargin = doc.page.margins.left;
      const columns = [
        { start: 0, end: 24, x: leftMargin },
        { start: 25, end: 49, x: leftMargin + columnWidth },
        { start: 50, end: 74, x: leftMargin + columnWidth * 2 },
        { start: 75, end: 99, x: leftMargin + columnWidth * 3 },
      ];

      // Altura de línea
      const lineHeight = 11;
      let currentY = doc.y;

      // Renderizar las 25 filas (cada fila tiene 4 columnas)
      for (let row = 0; row < 25; row++) {
        columns.forEach((col) => {
          const num = (col.start + row).toString().padStart(2, '0');
          const data = numbersMap.get(num);
          if (!data) return;

          const normalAmount = formatCurrency(data.amountByNumber);
          const reventadoAmount = formatCurrency(data.amountByReventado);

          let text = '';
          if (data.amountByNumber > 0 && data.amountByReventado > 0) {
            // Ambos
            text = `${num} - ¢ ${normalAmount}  R - ¢ ${reventadoAmount}`;
          } else if (data.amountByNumber > 0) {
            // Solo normal
            text = `${num} - ¢ ${normalAmount}`;
          } else if (data.amountByReventado > 0) {
            // Solo reventado
            text = `${num} - ¢ 0  R - ¢ ${reventadoAmount}`;
          } else {
            // Ninguno
            text = `${num} - ¢ 0`;
          }

          doc.text(text, col.x, currentY, { width: columnWidth - 5, lineBreak: false });
        });

        currentY += lineHeight;

        // Si llegamos al final de la página, crear nueva página
        if (currentY > doc.page.height - doc.page.margins.bottom - 30) {
          doc.addPage();
          currentY = doc.page.margins.top;
        }
      }

      // 6. PIE DE PÁGINA (opcional)
      doc.fontSize(8);
      const footerY = doc.page.height - doc.page.margins.bottom;
      doc.text(`Generado por Bancas Admin - ${generatedAt}`, 0, footerY, {
        align: 'center',
        width: doc.page.width,
      });

      doc.end();

      logger.info({
        layer: 'service',
        action: 'PDF_GENERATED',
        payload: {
          userName,
          totalNumbers: data.numbers.length,
          totalAmount: data.meta.totalAmount,
        },
      });
    } catch (err: any) {
      logger.error({
        layer: 'service',
        action: 'PDF_GENERATION_ERROR',
        payload: { message: err.message },
      });
      reject(err);
    }
  });
}
