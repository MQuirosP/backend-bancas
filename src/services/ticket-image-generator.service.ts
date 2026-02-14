import { createCanvas, loadImage } from 'canvas';
import logger from '../core/logger';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import bwipjs from 'bwip-js';
import { getCRLocalComponents } from '../utils/businessDate';

interface TicketImageOptions {
  width: number; // Ancho en píxeles (220px para 58mm o 340px para 88mm)
  scale?: number; // Factor de escala para calidad (default: 2)
}

interface TicketData {
  ticket: {
    id: string;
    ticketNumber: string;
    totalAmount: number;
    clienteNombre: string | null;
    createdAt: Date;
    jugadas: Array<{
      type: string;
      number: string;
      amount: number;
      finalMultiplierX: number;
    }>;
    sorteo: {
      name: string;
      scheduledAt: Date;
      loteria: {
        name: string;
        rulesJson?: any;
      };
    };
    vendedor: {
      name: string | null;
      code: string | null;
      printName: string | null;
      printPhone: string | null;
      printBarcode: boolean;
      printFooter: string | null;
    };
    ventana: {
      name: string | null;
      printName: string | null;
      printPhone: string | null;
      printBarcode: boolean;
      printFooter: string | null;
    };
    isActive: boolean; // Add isActive property
  };
}

interface Group {
  amount: number;
  numbers: string[];
}

/**
 * Formatea fecha para impresión térmica: "dd/MM/yy HH:mm"
 * Usa hora local de Costa Rica
 */
function formatDateForThermal(date: Date): string {
  const { year, month, day } = getCRLocalComponents(date);
  const dayStr = String(day).padStart(2, '0');
  const monthStr = String(month).padStart(2, '0');
  const yearStr = String(year).slice(-2); // Últimos 2 dígitos del año
  const time12h = formatTime12h(date);
  return `${dayStr}/${monthStr}/${yearStr} ${time12h}`;
}

/**
 * Formatea la hora de un Date a formato "h:mm a" (ej: "7:00 PM", "12:00 PM")
 * Usa hora local de Costa Rica
 */
function formatTime12h(date: Date): string {
  const { hour, minute } = getCRLocalComponents(date);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  let hours12 = hour % 12;
  hours12 = hours12 || 12; // 0 debe ser 12
  const minutesStr = String(minute).padStart(2, '0');
  return `${hours12}:${minutesStr} ${ampm}`;
}

/**
 * Formatea lista de números en filas de 5, separados por espacios
 */
function formatNumbersListForThermal(numbers: string[]): string[] {
  const rows: string[] = [];
  for (let i = 0; i < numbers.length; i += 5) {
    const row = numbers.slice(i, i + 5).join(' ');
    rows.push(row);
  }
  return rows;
}

/**
 * Agrupa jugadas por amount y separa NUMERO de REVENTADO
 */
function groupJugadasByAmount(jugadas: Array<{ type: string; number: string; amount: number }>): {
  numeros: Group[];
  reventados: Group[];
} {
  const numerosMap = new Map<number, string[]>();
  const reventadosMap = new Map<number, string[]>();

  for (const jugada of jugadas) {
    const map = jugada.type === 'REVENTADO' ? reventadosMap : numerosMap;
    if (!map.has(jugada.amount)) {
      map.set(jugada.amount, []);
    }
    map.get(jugada.amount)!.push(jugada.number);
  }

  const numeros: Group[] = Array.from(numerosMap.entries())
    .map(([amount, numbers]) => ({ amount, numbers }))
    .sort((a, b) => b.amount - a.amount); // Ordenar por amount descendente

  const reventados: Group[] = Array.from(reventadosMap.entries())
    .map(([amount, numbers]) => ({ amount, numbers }))
    .sort((a, b) => b.amount - a.amount);

  return { numeros, reventados };
}

/**
 * Envuelve texto largo en múltiples líneas
 */
function wrapText(text: string, maxWidth: number, ctx: any, fontSize: number, fontWeight: string = ''): string[] {
  ctx.font = `${fontWeight ? fontWeight + ' ' : ''}${fontSize}px monospace`;

  // Respetar saltos de línea explícitos del usuario (\n o \r\n)
  const paragraphs = text.split(/\r?\n/);
  const allLines: string[] = [];

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (trimmed.length === 0) {
      allLines.push('');
      continue;
    }

    // Word-wrap dentro de cada párrafo
    const words = trimmed.split(' ');
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxWidth && currentLine) {
        allLines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) {
      allLines.push(currentLine);
    }
  }

  return allLines.length > 0 ? allLines : [text];
}

/**
 * Genera una imagen PNG del ticket para impresión térmica según especificación exacta
 */
export async function generateTicketImage(
  ticketData: TicketData,
  options: TicketImageOptions
): Promise<Buffer> {
  const { width, scale = 2 } = options;
  const canvasWidth = width * scale;
  const padding = 4 * scale; // $1 = 4px
  const sectionGap = 8 * scale; // $2 = 8px
  const lineGap = 1 * scale; // Gap entre líneas dentro de sección

  // Calcular altura aproximada (se ajustará dinámicamente)
  const canvasHeight = calculateTicketHeight(ticketData, scale, padding, sectionGap, canvasWidth, lineGap);

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');

  // Configurar fondo blanco
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Configurar fuente base
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  let y = padding;

  // ========== 1. ENCABEZADO ==========
  ctx.font = `900 ${14 * scale}px monospace`;
  ctx.textAlign = 'center';

  const ticketNumber = String(ticketData.ticket.ticketNumber ?? ticketData.ticket.id).toUpperCase();
  ctx.fillText(`CODIGO # ${ticketNumber}`, canvasWidth / 2, y);
  y += 14 * scale + 4 * scale; // fontSize + gap

  // Verificar si está ANULADO y mostrarlo visiblemente
  // if (ticketData.ticket.isActive === false) {
  //   ctx.font = `900 ${16 * scale}px monospace`;
  //   ctx.fillText('*** ANULADO ***', canvasWidth / 2, y);
  //   y += 16 * scale + sectionGap;
  //   ctx.textAlign = 'center'; // Restaurar alineación
  // }

  ctx.font = `900 ${14 * scale}px monospace`; // Restaurar fuente normal
  const loteriaName = (ticketData.ticket.sorteo.loteria.name ?? 'TICA').toUpperCase();
  //  CRÍTICO: Usar formatTime12h para obtener hora correcta en Costa Rica
  const horaFormateada = ticketData.ticket.sorteo.scheduledAt
    ? formatTime12h(ticketData.ticket.sorteo.scheduledAt).toUpperCase()
    : '12:00 AM';
  ctx.fillText(`${loteriaName} TIEMPOS ${horaFormateada}`, canvasWidth / 2, y);
  y += 14 * scale + sectionGap;

  ctx.textAlign = 'left';

  // ========== 2. INFORMACIÓN DEL TICKET ==========
  ctx.font = `900 ${13 * scale}px monospace`;

  const printName = ticketData.ticket.vendedor.printName ?? ticketData.ticket.vendedor.name ?? 'Nombre Vendedor';
  const code = ticketData.ticket.vendedor.code ? ` - ${ticketData.ticket.vendedor.code}` : '';
  const vendedorText = `VENDEDOR: ${printName}${code}`;
  const vendedorLines = wrapText(vendedorText, canvasWidth - 2 * padding, ctx, 13 * scale, '900');
  for (const line of vendedorLines) {
    ctx.fillText(line, padding, y);
    y += 13 * scale + lineGap;
  }

  const printPhone = ticketData.ticket.vendedor.printPhone ?? ticketData.ticket.vendedor.printPhone ?? '8888-8888';
  ctx.fillText(`TEL.: ${printPhone}`, padding, y);
  y += 13 * scale + lineGap;

  const clienteNombre = ticketData.ticket.clienteNombre ?? 'CLIENTE CONTADO';
  const clienteText = `CLIENTE: ${clienteNombre}`;
  const clienteLines = wrapText(clienteText, canvasWidth - 2 * padding, ctx, 13 * scale, '900');
  for (const line of clienteLines) {
    ctx.fillText(line, padding, y);
    y += 13 * scale + lineGap;
  }

  //  CRÍTICO: Usar getCRLocalComponents para obtener fecha/hora correcta en Costa Rica
  const fechaFormateada = ticketData.ticket.sorteo.scheduledAt
    ? (() => {
      const { year, month, day } = getCRLocalComponents(ticketData.ticket.sorteo.scheduledAt);
      const dayStr = String(day).padStart(2, '0');
      const monthStr = String(month).padStart(2, '0');
      return `${dayStr}/${monthStr}/${year}`;
    })()
    : '--/--/----';
  ctx.fillText(`SORTEO: ${fechaFormateada}`, padding, y);
  y += 13 * scale + lineGap;

  //  CRÍTICO: Usar getCRLocalComponents para obtener hora correcta en Costa Rica
  const horaFormateada12 = ticketData.ticket.sorteo.scheduledAt
    ? formatTime12h(ticketData.ticket.sorteo.scheduledAt)
    : '--:-- --';
  ctx.fillText(`TIEMPOS: ${horaFormateada12}`, padding, y);
  y += 13 * scale + lineGap;

  const createdAtFormateado = formatDateForThermal(ticketData.ticket.createdAt);
  ctx.fillText(`IMPRESIÓN: ${createdAtFormateado}`, padding, y);
  y += 13 * scale + sectionGap;

  // ========== 3. JUGADAS - NÚMEROS ==========
  const { numeros, reventados } = groupJugadasByAmount(ticketData.ticket.jugadas);
  const amountWidth = 60 * scale; // 60px fijo para amount*

  for (const group of numeros) {
    const amountStr = String(group.amount);
    const numberRows = formatNumbersListForThermal(group.numbers);

    // Primera línea: amount* + números
    ctx.font = `900 ${15 * scale}px monospace`;
    ctx.fillText(amountStr, padding, y);
    ctx.font = `900 ${18 * scale}px monospace`;
    const asteriskX = padding + ctx.measureText(amountStr).width;
    ctx.fillText('*', asteriskX, y - 1 * scale); // Ajuste vertical para alinear
    const numbersX = padding + amountWidth;
    ctx.fillText(numberRows[0], numbersX, y);
    y += 18 * scale + lineGap;

    // Líneas siguientes: espacio en blanco + números
    for (let i = 1; i < numberRows.length; i++) {
      ctx.fillText(numberRows[i], numbersX, y);
      y += 18 * scale + lineGap;
    }
  }

  // ========== 4. JUGADAS - REVENTADOS ==========
  if (reventados.length > 0) {
    y += 2 * scale; // Margin vertical
    ctx.font = `${11 * scale}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('*******REVENTADOS*******', canvasWidth / 2, y);
    y += 11 * scale + 2 * scale;
    ctx.textAlign = 'left';

    for (const group of reventados) {
      const amountStr = String(group.amount);
      const numberRows = formatNumbersListForThermal(group.numbers);

      // Primera línea: amount* + números
      ctx.font = `900 ${15 * scale}px monospace`;
      ctx.fillText(amountStr, padding, y);
      ctx.font = `900 ${18 * scale}px monospace`;
      const asteriskX = padding + ctx.measureText(amountStr).width;
      ctx.fillText('*', asteriskX, y - 1 * scale);
      const numbersX = padding + amountWidth;
      ctx.fillText(numberRows[0], numbersX, y);
      y += 18 * scale + lineGap;

      // Líneas siguientes
      for (let i = 1; i < numberRows.length; i++) {
        ctx.fillText(numberRows[i], numbersX, y);
        y += 18 * scale + lineGap;
      }
    }
  }


  // ========== 4.5 ANULADO (COMO JUGADA) ==========
  if (ticketData.ticket.isActive === false) {
    y += sectionGap; // Espacio antes de ANULADO
    ctx.font = `900 ${18 * scale}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('*** ANULADO ***', canvasWidth / 2, y);
    ctx.textAlign = 'left';
    y += 18 * scale;
  }

  y += sectionGap;

  // ========== 5. TOTAL ==========
  ctx.font = `900 ${20 * scale}px monospace`;
  const totalFormateado = ticketData.ticket.totalAmount.toLocaleString('es-CR');
  const totalText = 'TOTAL';
  const totalValueX = canvasWidth - padding - ctx.measureText(totalFormateado).width;
  ctx.fillText(totalText, padding, y);
  ctx.fillText(totalFormateado, totalValueX, y);
  y += 20 * scale + sectionGap;

  // ========== 6. MULTIPLICADOR Y FOOTER ==========
  ctx.textAlign = 'center';

  // Obtener multiplierX
  const primeraJugadaNumero = ticketData.ticket.jugadas.find(j => j.type === 'NUMERO' && j.finalMultiplierX > 0);
  const multiplierX = primeraJugadaNumero?.finalMultiplierX ??
    ticketData.ticket.sorteo.loteria.rulesJson?.baseMultiplierX ??
    1;

  ctx.font = `900 ${12 * scale}px monospace`;
  ctx.fillText(`PAGAMOS ${multiplierX}x`, canvasWidth / 2, y);
  y += 12 * scale + 4 * scale;

  // Renderizar footer si existe y no está vacío (siempre usar el del vendedor)
  const footerText = ticketData.ticket.vendedor.printFooter;
  if (footerText && typeof footerText === 'string' && footerText.trim().length > 0) {
    ctx.font = `900 ${11 * scale}px monospace`;
    // Envolver texto largo si es necesario
    const footerLines = wrapText(footerText.trim(), canvasWidth - 2 * padding, ctx, 11 * scale, '900');
    const footerLineHeight = 14 * scale;
    for (const line of footerLines) {
      ctx.fillText(line, canvasWidth / 2, y);
      y += footerLineHeight;
    }
  } else {
    // Log para debugging si el footer no se renderiza
    logger.debug({
      layer: 'service',
      action: 'TICKET_FOOTER_NOT_RENDERED',
      payload: {
        ticketId: ticketData.ticket.id,
        printFooter: footerText,
        printFooterType: typeof footerText,
        printFooterLength: footerText ? footerText.length : 0,
      },
    });
  }

  y += 4 * scale; // Margin-top antes del código de barras

  // ========== 7. CÓDIGO DE BARRAS ==========
  // Validar siempre la configuración del vendedor: si está desactivado explícitamente, no mostrar código de barras
  // La configuración del vendedor tiene prioridad absoluta
  // Si el vendedor no tiene configuración (undefined/null), se asume true (mostrar)
  // Si el vendedor tiene printBarcode: false, NO mostrar (sin importar la ventana)
  const vendedorBarcodeEnabled = ticketData.ticket.vendedor.printBarcode !== false;
  const ventanaBarcodeEnabled = ticketData.ticket.ventana.printBarcode !== false;
  const shouldShowBarcode = vendedorBarcodeEnabled && ventanaBarcodeEnabled;

  if (shouldShowBarcode) {
    try {
      const barcodeText = ticketNumber;

      // Calcular exactamente como el frontend
      // Padding: 8px (4px cada lado)
      const padding = 8 * scale;
      const barcodeWidth = Math.floor((canvasWidth - padding) * 0.90);

      // Calcular barWidth dinámicamente igual que el frontend
      // barWidth = max(2, min(3, floor(barcodeWidth / (estimatedChars * 15))))
      const estimatedChars = barcodeText.length;
      const barWidth = Math.max(2, Math.min(3, Math.floor(barcodeWidth / (estimatedChars * 15))));

      // Generar código de barras CODE128 con los mismos parámetros que el frontend
      // En bwip-js, 'scale' es el ancho del módulo (equivalente a 'width' en jsbarcode)
      const barcodeBuffer = await bwipjs.toBuffer({
        bcid: 'code128', // Formato CODE128
        text: barcodeText,
        scale: barWidth, // Ancho de cada barra (2-3px) - igual que jsbarcode width
        height: 35 * scale, // Altura: 35px (reducida de 50px)
        includetext: true, // Mostrar texto debajo
        textfont: 'monospace',
        textsize: 12 * scale, // Tamaño de fuente: 12px
        textxalign: 'center',
        textyoffset: 4 * scale, // Margen texto: 4px
        paddingwidth: 0, // Margen externo: 0
        paddingheight: 0,
      });

      // Cargar imagen del código de barras
      const barcodeImage = await loadImage(barcodeBuffer);

      // Si el ancho generado excede el máximo, escalarlo (igual que el frontend con viewBox)
      let finalWidth = barcodeImage.width;
      let finalHeight = barcodeImage.height;

      if (barcodeImage.width > barcodeWidth) {
        const scaleRatio = barcodeWidth / barcodeImage.width;
        finalWidth = barcodeWidth;
        finalHeight = barcodeImage.height * scaleRatio;
      }

      // Centrar horizontalmente
      const barcodeX = (canvasWidth - finalWidth) / 2;

      // Dibujar código de barras
      ctx.drawImage(barcodeImage, barcodeX, y, finalWidth, finalHeight);
      y += finalHeight + 4 * scale;
    } catch (error: any) {
      // Si falla la generación, mostrar texto como fallback
      logger.warn({
        layer: 'service',
        action: 'TICKET_BARCODE_GENERATION_FAILED',
        payload: {
          ticketId: ticketData.ticket.id,
          error: error.message,
        },
      });
      ctx.font = `${12 * scale}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(ticketNumber, canvasWidth / 2, y);
      y += 12 * scale + 4 * scale;
    }
  }

  // Convertir canvas a Buffer PNG
  return canvas.toBuffer('image/png');
}

/**
 * Calcula la altura del canvas basándose en el contenido del ticket
 */
function calculateTicketHeight(
  ticketData: TicketData,
  scale: number,
  padding: number,
  sectionGap: number,
  canvasWidth: number,
  lineGap: number
): number {
  let height = padding * 2; // Padding superior e inferior

  // Encabezado
  height += 14 * scale * 2 + 4 * scale + sectionGap; // 2 líneas + gap

  // Información del ticket (aproximado)
  height += 13 * scale * 6 + sectionGap; // 6 líneas aproximadas

  // Jugadas
  const { numeros, reventados } = groupJugadasByAmount(ticketData.ticket.jugadas);
  for (const group of numeros) {
    const rows = Math.ceil(group.numbers.length / 5);
    height += 18 * scale * rows + 1 * scale;
  }

  if (reventados.length > 0) {
    height += 11 * scale + 4 * scale; // Separador
    for (const group of reventados) {
      const rows = Math.ceil(group.numbers.length / 5);
      height += 18 * scale * rows + 1 * scale;
    }
  }

  // Altura para ANULADO
  if (ticketData.ticket.isActive === false) {
    height += sectionGap + 18 * scale;
  }

  height += sectionGap;

  // TOTAL
  height += 20 * scale + sectionGap;

  // MULTIPLICADOR Y FOOTER
  height += 12 * scale + 4 * scale;
  // Calcular altura del footer si existe y no está vacío (siempre usar el del vendedor)
  const footerText = ticketData.ticket.vendedor.printFooter;
  if (footerText && typeof footerText === 'string' && footerText.trim().length > 0) {
    // Usar un canvas temporal para medir el texto exactamente igual que en el renderizado
    const tempCanvas = createCanvas(canvasWidth, 100);
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.font = `900 ${11 * scale}px monospace`;
    const maxWidth = canvasWidth - 2 * padding;
    const footerLines = wrapText(footerText.trim(), maxWidth, tempCtx, 11 * scale, '900');
    const footerLinesCount = footerLines.length;
    const footerLineHeight = 14 * scale;
    height += footerLineHeight * footerLinesCount;
  }

  // CÓDIGO DE BARRAS
  // Validar siempre la configuración del vendedor
  const shouldShowBarcode = ticketData.ticket.vendedor.printBarcode !== false &&
    ticketData.ticket.ventana.printBarcode !== false;
  if (shouldShowBarcode) {
    height += 12 * scale + 4 * scale + 50 * scale; // Texto + espacio para código de barras
  }

  return height;
}

/**
 * Convierte ancho de papel en mm a píxeles (a 96 DPI)
 */
export function mmToPixels(widthMm: number | null): number {
  if (!widthMm) {
    return 220; // Default: 58mm (220px)
  }

  if (widthMm === 58) {
    return 220;
  } else if (widthMm === 88) {
    return 340;
  }

  // Fallback: calcular proporcionalmente
  return Math.round(widthMm * 3.779527559);
}

