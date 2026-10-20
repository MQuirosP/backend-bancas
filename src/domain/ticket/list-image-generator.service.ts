import { createCanvas } from 'canvas';
import logger from '../../core/logger';

export interface NumbersSummaryListData {
  meta: {
    vendedorName?: string;
    ventanaName?: string;
    vendedorCode?: string;
    loteriaName?: string;
    sorteoName?: string;
    sorteoDate?: Date | string;
    multiplierName?: string;
    totalAmount: number;
    totalAmountByNumber: number;
    totalAmountByReventado: number;
    sorteoDigits?: number;
    maxNumber?: number;
    numbersWithBets?: string[];
  };
  numbers: Array<{
    number: string;
    amountByNumber: number;
    amountByReventado: number;
  }>;
  onlyWithSales?: boolean;
}

export interface ListImagePage {
  page: number;
  buffer: Buffer;
}

/**
 * Formatea un número con separador de miles (punto) sin decimales.
 * Ejemplo: 1500 -> "1.500", 125000 -> "125.000"
 */
function formatCurrency(amount: number): string {
  return Math.round(amount || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * Genera el encabezado estándar idéntico al reporte formal.
 */
function drawHeader(
  ctx: any,
  data: NumbersSummaryListData,
  canvasWidth: number,
  leftMargin: number,
  scale: number
): number {
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

  let currentY = 24 * scale;
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  // 1. Usuario (Más prominente)
  ctx.font = `bold ${18 * scale}px "Courier New", Courier, monospace`;
  ctx.fillText(`Usuario: ${userName}${userCode}`, leftMargin, currentY);
  currentY += 22 * scale;

  // 2. Información del sorteo (en negrita y tamaño mayor para nitidez en móvil)
  ctx.font = `bold ${14 * scale}px "Courier New", Courier, monospace`;
  ctx.fillText(`Fecha y hora de generación: ${generatedAt}`, leftMargin, currentY);
  currentY += 18 * scale;

  // 3. Lotería, Sorteo, Multiplicador, Fecha
  if (data.meta.loteriaName) {
    ctx.fillText(`Lotería: ${data.meta.loteriaName}`, leftMargin, currentY);
    currentY += 18 * scale;
  }
  if (data.meta.sorteoName) {
    ctx.fillText(`Sorteo: ${data.meta.sorteoName}`, leftMargin, currentY);
    currentY += 18 * scale;
  }
  if (data.meta.multiplierName) {
    ctx.fillText(`Multiplicador: ${data.meta.multiplierName}`, leftMargin, currentY);
    currentY += 18 * scale;
  }
  if (data.meta.sorteoDate) {
    const sDate = typeof data.meta.sorteoDate === 'string' ? new Date(data.meta.sorteoDate) : data.meta.sorteoDate;
    const sorteoDateStr = sDate.toLocaleString('es-CR', {
      timeZone: 'America/Costa_Rica',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    ctx.fillText(`Fecha del sorteo: ${sorteoDateStr}`, leftMargin, currentY);
    currentY += 18 * scale;
  }

  currentY += 4 * scale;

  // 4. Línea separadora
  ctx.textAlign = 'center';
  ctx.font = `bold ${13 * scale}px "Courier New", Courier, monospace`;
  ctx.fillText('------------------------------------------------------------------', canvasWidth / 2, currentY);
  currentY += 16 * scale;

  // 5. Totales
  ctx.font = `bold ${15 * scale}px "Courier New", Courier, monospace`;
  ctx.fillText(`TOTAL GENERAL: ¢ ${formatCurrency(data.meta.totalAmount)}`, canvasWidth / 2, currentY);
  currentY += 18 * scale;

  ctx.fillText(`Normal: ¢ ${formatCurrency(data.meta.totalAmountByNumber)}`, canvasWidth / 2, currentY);
  currentY += 18 * scale;

  ctx.fillText(`Reventados: ¢ ${formatCurrency(data.meta.totalAmountByReventado)}`, canvasWidth / 2, currentY);
  currentY += 18 * scale;

  // 6. Línea separadora
  ctx.font = `bold ${13 * scale}px "Courier New", Courier, monospace`;
  ctx.fillText('------------------------------------------------------------------', canvasWidth / 2, currentY);
  currentY += 20 * scale;

  ctx.textAlign = 'left';
  return currentY;
}

/**
 * Renderiza una página individual de la lista a Buffer PNG manteniendo estrictamente el tamaño Carta (US Letter 8.5" x 11").
 */
function renderSinglePage(
  data: NumbersSummaryListData,
  pageNumbers: Array<{ number: string; amountByNumber: number; amountByReventado: number }>,
  sorteoDigits: number,
  scale = 2
): Buffer {
  // Dimensiones estrictas Carta (US Letter: 8.5" x 11" -> 612 x 792 pt base)
  const baseWidth = 612;
  const baseHeight = 792;
  const canvasWidth = baseWidth * scale;
  const canvasHeight = baseHeight * scale;

  const leftMargin = 28 * scale;
  const contentWidth = canvasWidth - leftMargin * 2;

  const numColumns = sorteoDigits === 3 ? 4 : 3;
  const columnWidth = Math.floor(contentWidth / numColumns);

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');

  // Fondo blanco nítido
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Dibujar encabezado
  const startY = drawHeader(ctx, data, canvasWidth, leftMargin, scale);

  const totalItems = pageNumbers.length;
  if (totalItems === 0) {
    ctx.textAlign = 'center';
    ctx.font = `${14 * scale}px "Courier New", Courier, monospace`;
    ctx.fillStyle = '#666666';
    ctx.fillText('No hay números con ventas', canvasWidth / 2, startY + 20 * scale);
    return canvas.toBuffer('image/png');
  }

  // Calcular filas requeridas según el número de columnas
  const rows = Math.max(1, Math.ceil(totalItems / numColumns));

  // Ajuste de altura e interlineado para mantener el tamaño Carta estricto
  const availableHeight = canvasHeight - startY - 20 * scale;
  const maxLineHeight = availableHeight / rows;
  const idealLineHeight = (sorteoDigits === 3 ? 11 : 15.5) * scale;
  const lineHeight = Math.min(idealLineHeight, maxLineHeight);

  // Tamaño de fuente nítido proporcional al interlineado
  const idealFontSize = (sorteoDigits === 3 ? 10.5 : 14.5) * scale;
  const fontSize = Math.min(idealFontSize, lineHeight * 0.95);

  ctx.textAlign = 'left';
  ctx.font = `bold ${fontSize}px "Courier New", Courier, monospace`;
  ctx.fillStyle = '#000000';

  for (let i = 0; i < totalItems; i++) {
    const item = pageNumbers[i];
    const col = Math.floor(i / rows);
    const row = i % rows;

    const x = leftMargin + col * columnWidth;
    const y = startY + row * lineHeight;

    const normal = formatCurrency(item.amountByNumber);
    const rev = formatCurrency(item.amountByReventado);

    let text = '';
    if (item.amountByNumber > 0 && item.amountByReventado > 0) {
      text = `${item.number}-${normal} R-${rev}`;
    } else if (item.amountByNumber > 0) {
      text = `${item.number}-${normal}`;
    } else if (item.amountByReventado > 0) {
      text = `${item.number}-0 R-${rev}`;
    } else {
      text = `${item.number}-0`;
    }

    ctx.fillText(text, x, y);
  }

  return canvas.toBuffer('image/png');
}

/**
 * Genera todas las páginas PNG requeridas para una lista de números.
 */
export async function generateListImagePages(
  data: NumbersSummaryListData,
  options: { sorteoDigits?: number; scale?: number } = {}
): Promise<ListImagePage[]> {
  const startTime = Date.now();
  const sorteoDigits = options.sorteoDigits ?? data.meta.sorteoDigits ?? 2;
  const padLength = sorteoDigits;
  const maxNumber = sorteoDigits === 3 ? 999 : 99;
  const scale = options.scale ?? 2;

  // Mapa de números indexado
  const numbersMap = new Map<string, { amountByNumber: number; amountByReventado: number }>();
  (data.numbers || []).forEach((item) => {
    const num = item.number.padStart(padLength, '0');
    numbersMap.set(num, {
      amountByNumber: item.amountByNumber || 0,
      amountByReventado: item.amountByReventado || 0,
    });
  });

  const shouldFilterBySales = data.onlyWithSales === true || data.numbers.length < maxNumber + 1;

  if (shouldFilterBySales) {
    // Modo filtrado: solo números con apuestas
    const filteredList: Array<{ number: string; amountByNumber: number; amountByReventado: number }> = [];

    const numbersWithBets = data.meta.numbersWithBets || [];
    if (numbersWithBets.length > 0) {
      numbersWithBets.forEach((numStr) => {
        const padded = numStr.padStart(padLength, '0');
        const numData = numbersMap.get(padded) || { amountByNumber: 0, amountByReventado: 0 };
        filteredList.push({ number: padded, ...numData });
      });
    } else {
      // Si no viene numbersWithBets, buscar en map los que tengan ventas > 0
      Array.from(numbersMap.entries()).forEach(([num, val]) => {
        if (val.amountByNumber > 0 || val.amountByReventado > 0) {
          filteredList.push({ number: num, ...val });
        }
      });
    }

    filteredList.sort((a, b) => parseInt(a.number, 10) - parseInt(b.number, 10));

    const buffer = renderSinglePage(data, filteredList, sorteoDigits, scale);
    logger.info({
      layer: 'list-image-generator',
      action: 'LIST_IMAGE_GENERATED_FILTERED',
      payload: {
        sorteoDigits,
        itemsCount: filteredList.length,
        durationMs: Date.now() - startTime,
        bufferSize: buffer.length,
      },
    });

    return [{ page: 0, buffer }];
  }

  if (sorteoDigits === 2) {
    // Tiempos (00-99): Exactamente 1 página completa con 100 números
    const fullList: Array<{ number: string; amountByNumber: number; amountByReventado: number }> = [];
    for (let i = 0; i <= 99; i++) {
      const num = i.toString().padStart(2, '0');
      const val = numbersMap.get(num) || { amountByNumber: 0, amountByReventado: 0 };
      fullList.push({ number: num, ...val });
    }

    const buffer = renderSinglePage(data, fullList, 2, scale);
    logger.info({
      layer: 'list-image-generator',
      action: 'LIST_IMAGE_GENERATED_TIEMPOS',
      payload: {
        durationMs: Date.now() - startTime,
        bufferSize: buffer.length,
      },
    });

    return [{ page: 0, buffer }];
  }

  // Monazos (000-999): 5 páginas de 200 números cada una (000-199, 200-399, etc.)
  const pages: ListImagePage[] = [];
  const numbersPerPage = 200;

  for (let pageIdx = 0; pageIdx < 5; pageIdx++) {
    const pageList: Array<{ number: string; amountByNumber: number; amountByReventado: number }> = [];
    const startNum = pageIdx * numbersPerPage;
    const endNum = startNum + numbersPerPage - 1;

    for (let i = startNum; i <= endNum; i++) {
      const num = i.toString().padStart(3, '0');
      const val = numbersMap.get(num) || { amountByNumber: 0, amountByReventado: 0 };
      pageList.push({ number: num, ...val });
    }

    const buffer = renderSinglePage(data, pageList, 3, scale);
    pages.push({ page: pageIdx, buffer });
  }

  logger.info({
    layer: 'list-image-generator',
    action: 'LIST_IMAGE_GENERATED_MONAZOS',
    payload: {
      totalPages: pages.length,
      durationMs: Date.now() - startTime,
      totalBytes: pages.reduce((acc, p) => acc + p.buffer.length, 0),
    },
  });

  return pages;
}
