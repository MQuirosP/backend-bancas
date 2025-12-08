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
    sorteoDigits?: number; // ✅ NUEVO: Número de dígitos (2 o 3)
    maxNumber?: number;    // ✅ NUEVO: Número máximo (99 o 999)
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

      // ✅ El encabezado se renderizará en cada página usando la función renderHeader

      // ✅ Detectar número de dígitos dinámicamente
      const sorteoDigits = data.meta.sorteoDigits ?? 2;
      const padLength = sorteoDigits;

      // Crear un mapa de números para acceso rápido
      const numbersMap = new Map<string, { amountByNumber: number; amountByReventado: number }>();
      data.numbers.forEach((item) => {
        numbersMap.set(item.number.padStart(padLength, '0'), {
          amountByNumber: item.amountByNumber,
          amountByReventado: item.amountByReventado,
        });
      });

      // ✅ Determinar si debemos generar todos los números o solo los filtrados
      // Si data.numbers está vacío o tiene menos números que el rango completo, asumimos que está filtrado
      const maxNumber = sorteoDigits === 3 ? 999 : 99;
      const isFiltered = data.numbers.length < maxNumber + 1;
      
      if (isFiltered) {
        // ✅ Modo filtrado: solo generar los números que están en la lista
        // No agregar números faltantes, solo usar los que están presentes
        logger.info({
          layer: 'service',
          action: 'PDF_GENERATION_FILTERED_MODE',
          payload: {
            totalNumbers: data.numbers.length,
            maxNumber,
            sorteoDigits,
          },
        });
      } else {
        // ✅ Modo completo: generar todos los números del rango
        // Asegurar que todos los números existan (rango completo)
        for (let i = 0; i <= maxNumber; i++) {
          const num = i.toString().padStart(padLength, '0');
          if (!numbersMap.has(num)) {
            numbersMap.set(num, { amountByNumber: 0, amountByReventado: 0 });
          }
        }
      }

      // ✅ Configuración de columnas dinámica
      const columnWidth = sorteoDigits === 3 ? 140 : 130; // Más ancho para 3 dígitos
      const leftMargin = doc.page.margins.left;
      
      // Para 2 dígitos: 4 columnas de 25 números cada una (0-24, 25-49, 50-74, 75-99) = 1 página
      // Para 3 dígitos: 4 columnas de 50 números cada una por página (200 números por página) = 5 páginas
      const numbersPerColumn = sorteoDigits === 3 ? 50 : 25; // 50 números por columna para monazos, 25 para tiempos
      const numbersPerPage = numbersPerColumn * 4; // 200 números por página para monazos, 100 para tiempos

      // Altura de línea
      const lineHeight = 11;
      
      // ✅ Función helper para renderizar encabezado en cada página
      const renderHeader = () => {
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
        doc.text('--------------------------------------------------------', { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(12).font('Courier-Bold');
        doc.text(`TOTAL GENERAL: ¢ ${formatCurrency(data.meta.totalAmount)}`, { align: 'center' });
        doc.fontSize(10).font('Courier');
        doc.text(`Normal: ¢ ${formatCurrency(data.meta.totalAmountByNumber)}`, { align: 'center' });
        doc.text(`Reventados: ¢ ${formatCurrency(data.meta.totalAmountByReventado)}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.text('--------------------------------------------------------', { align: 'center' });
        doc.moveDown(1);
      };

      // ✅ Renderizar números según el modo (filtrado o completo)
      if (isFiltered) {
        // ✅ Modo filtrado: solo generar los números que están en numbersMap
        // Obtener lista ordenada de números
        const sortedNumbers = Array.from(numbersMap.keys())
          .map(num => parseInt(num, 10))
          .sort((a, b) => a - b);
        
        if (sortedNumbers.length === 0) {
          // No hay números - solo renderizar encabezado
          renderHeader();
          doc.fontSize(10).font('Courier');
          doc.text('No hay números con ventas', { align: 'center' });
        } else {
          // Renderizar encabezado
          renderHeader();
          
          // Posición Y inicial después del encabezado
          let currentY = doc.y;
          doc.fontSize(11).font('Courier-Bold'); // ✅ Aumentado tamaño y negrita
          
          // Calcular cuántas filas caben en una página
          const availableHeight = doc.page.height - doc.page.margins.top - doc.page.margins.bottom - 200; // 200px para encabezado
          const maxRowsPerPage = Math.floor(availableHeight / lineHeight);
          
          // Renderizar números en columnas (4 columnas)
          let columnIndex = 0;
          const startX = leftMargin;
          
          for (let i = 0; i < sortedNumbers.length; i++) {
            const numValue = sortedNumbers[i];
            const num = numValue.toString().padStart(padLength, '0');
            const numData = numbersMap.get(num);
            if (!numData) continue;
            
            const column = columnIndex % 4;
            const row = Math.floor(columnIndex / 4);
            
            // Si necesitamos nueva página, crearla
            if (row > 0 && row % maxRowsPerPage === 0) {
              doc.addPage();
              renderHeader();
              currentY = doc.y;
              columnIndex = 0;
              // Reiniciar el cálculo para este número
              i--; // Volver al número anterior para procesarlo en la nueva página
              continue;
            }
            
            const x = startX + column * columnWidth;
            const y = currentY + (row % maxRowsPerPage) * lineHeight;
            
            const normalAmount = formatCurrency(numData.amountByNumber);
            const reventadoAmount = formatCurrency(numData.amountByReventado);
            
            let text = '';
            if (numData.amountByNumber > 0 && numData.amountByReventado > 0) {
              // Ambos
              text = `${num} - ¢ ${normalAmount}  R - ¢ ${reventadoAmount}`;
            } else if (numData.amountByNumber > 0) {
              // Solo normal
              text = `${num} - ¢ ${normalAmount}`;
            } else if (numData.amountByReventado > 0) {
              // Solo reventado
              text = `${num} - ¢ 0  R - ¢ ${reventadoAmount}`;
            } else {
              // Ninguno (no debería pasar en modo filtrado, pero por seguridad)
              text = `${num} - ¢ 0`;
            }
            
            doc.text(text, x, y, { width: columnWidth - 5, lineBreak: false });
            columnIndex++;
          }
        }
      } else {
        // ✅ Modo completo: generar todos los números por bloques de 100
        let currentPageStart = 0;
        let isFirstPage = true;

        while (currentPageStart <= maxNumber) {
          // Si no es la primera página, crear nueva página antes de renderizar encabezado
          if (!isFirstPage) {
            doc.addPage();
          } else {
            isFirstPage = false;
          }
          
          // Renderizar encabezado en cada página
          renderHeader();

          // Calcular rango de números para esta página
          const pageEnd = Math.min(currentPageStart + numbersPerPage - 1, maxNumber);
          const numbersInPage = pageEnd - currentPageStart + 1;
          const rowsInPage = Math.ceil(numbersInPage / 4);

          // Configurar columnas para esta página
          const columns = [
            { start: currentPageStart, x: leftMargin },
            { start: currentPageStart + numbersPerColumn, x: leftMargin + columnWidth },
            { start: currentPageStart + numbersPerColumn * 2, x: leftMargin + columnWidth * 2 },
            { start: currentPageStart + numbersPerColumn * 3, x: leftMargin + columnWidth * 3 },
          ];

          // Posición Y inicial después del encabezado
          let currentY = doc.y;
          doc.fontSize(11).font('Courier-Bold'); // ✅ Aumentado tamaño y negrita

          // Renderizar filas de esta página
          for (let row = 0; row < rowsInPage; row++) {
            columns.forEach((col) => {
              const numValue = col.start + row;
              if (numValue > maxNumber) return; // Saltar si excede el máximo

              const num = numValue.toString().padStart(padLength, '0');
              const numData = numbersMap.get(num);
              if (!numData) return;

              const normalAmount = formatCurrency(numData.amountByNumber);
              const reventadoAmount = formatCurrency(numData.amountByReventado);

              let text = '';
              if (numData.amountByNumber > 0 && numData.amountByReventado > 0) {
                // Ambos
                text = `${num} - ¢ ${normalAmount}  R - ¢ ${reventadoAmount}`;
              } else if (numData.amountByNumber > 0) {
                // Solo normal
                text = `${num} - ¢ ${normalAmount}`;
              } else if (numData.amountByReventado > 0) {
                // Solo reventado
                text = `${num} - ¢ 0  R - ¢ ${reventadoAmount}`;
              } else {
                // Ninguno
                text = `${num} - ¢ 0`;
              }

              doc.text(text, col.x, currentY, { width: columnWidth - 5, lineBreak: false });
            });

            currentY += lineHeight;
          }

          // Avanzar al siguiente rango de 100 números
          currentPageStart += numbersPerPage;
        }
      }

      // ✅ FIX: Eliminado pie de página que causaba página en blanco extra

      doc.end();

      const userName = data.meta.vendedorName || data.meta.ventanaName || 'Usuario';
      
      logger.info({
        layer: 'service',
        action: 'PDF_GENERATED',
        payload: {
          userName,
          totalNumbers: data.numbers.length,
          totalAmount: data.meta.totalAmount,
          sorteoDigits,
          maxNumber,
          numbersRange: `0-${maxNumber}`,
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
