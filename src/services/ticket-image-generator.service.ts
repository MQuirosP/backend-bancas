import { createCanvas, loadImage } from 'canvas';
import logger from '../core/logger';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import bwipjs from 'bwip-js';

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
    };
    ventana: {
      name: string | null;
      printName: string | null;
      printPhone: string | null;
      printBarcode: boolean;
      printFooter: string | null;
    };
  };
}

interface Group {
  amount: number;
  numbers: string[];
}

/**
 * Formatea fecha para impresión térmica: "dd/MM/yy HH:mm"
 */
function formatDateForThermal(date: Date): string {
  return format(date, 'dd/MM/yy HH:mm', { locale: es });
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
function wrapText(text: string, maxWidth: number, ctx: any, fontSize: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  ctx.font = `${fontSize}px monospace`;

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [text];
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
  const canvasHeight = calculateTicketHeight(ticketData, scale, padding, sectionGap);
  
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

  const loteriaName = (ticketData.ticket.sorteo.loteria.name ?? 'TICA').toUpperCase();
  const horaFormateada = ticketData.ticket.sorteo.scheduledAt
    ? format(ticketData.ticket.sorteo.scheduledAt, 'h:mm a', { locale: es }).toUpperCase()
    : '00:00 AM';
  ctx.fillText(`${loteriaName} TIEMPOS ${horaFormateada}`, canvasWidth / 2, y);
  y += 14 * scale + sectionGap;

  ctx.textAlign = 'left';

  // ========== 2. INFORMACIÓN DEL TICKET ==========
  ctx.font = `900 ${13 * scale}px monospace`;
  
  const printName = ticketData.ticket.vendedor.printName ?? ticketData.ticket.vendedor.name ?? 'Nombre Vendedor';
  const code = ticketData.ticket.vendedor.code ? ` - ${ticketData.ticket.vendedor.code}` : '';
  const vendedorText = `VENDEDOR: ${printName}${code}`;
  const vendedorLines = wrapText(vendedorText, canvasWidth - 2 * padding, ctx, 13 * scale);
  for (const line of vendedorLines) {
    ctx.fillText(line, padding, y);
    y += 13 * scale + lineGap;
  }

  const printPhone = ticketData.ticket.vendedor.printPhone ?? ticketData.ticket.vendedor.printPhone ?? '8888-8888';
  ctx.fillText(`TEL.: ${printPhone}`, padding, y);
  y += 13 * scale + lineGap;

  const clienteNombre = ticketData.ticket.clienteNombre ?? 'CLIENTE CONTADO';
  const clienteText = `CLIENTE: ${clienteNombre}`;
  const clienteLines = wrapText(clienteText, canvasWidth - 2 * padding, ctx, 13 * scale);
  for (const line of clienteLines) {
    ctx.fillText(line, padding, y);
    y += 13 * scale + lineGap;
  }

  const fechaFormateada = ticketData.ticket.sorteo.scheduledAt
    ? format(ticketData.ticket.sorteo.scheduledAt, 'dd/MM/yyyy', { locale: es })
    : '--/--/----';
  ctx.fillText(`SORTEO: ${fechaFormateada}`, padding, y);
  y += 13 * scale + lineGap;

  const horaFormateada24 = ticketData.ticket.sorteo.scheduledAt
    ? format(ticketData.ticket.sorteo.scheduledAt, 'HH:mm', { locale: es })
    : '--:--';
  ctx.fillText(`TIEMPOS: ${horaFormateada24} hrs`, padding, y);
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

  if (ticketData.ticket.ventana.printFooter) {
    ctx.font = `900 ${11 * scale}px monospace`;
    ctx.fillText(ticketData.ticket.ventana.printFooter, canvasWidth / 2, y);
    y += 11 * scale;
  }

  y += 4 * scale; // Margin-top antes del código de barras

  // ========== 7. CÓDIGO DE BARRAS ==========
  if (ticketData.ticket.vendedor.printBarcode !== false && ticketData.ticket.ventana.printBarcode !== false) {
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
  sectionGap: number
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

  height += sectionGap;

  // TOTAL
  height += 20 * scale + sectionGap;

  // MULTIPLICADOR Y FOOTER
  height += 12 * scale + 4 * scale;
  if (ticketData.ticket.ventana.printFooter) {
    height += 11 * scale;
  }

  // CÓDIGO DE BARRAS
  if (ticketData.ticket.vendedor.printBarcode !== false && ticketData.ticket.ventana.printBarcode !== false) {
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
