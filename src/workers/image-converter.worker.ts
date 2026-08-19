import { parentPort } from 'worker_threads';

/**
 * Worker para la conversión de PDF a PNG.
 * Ejecuta la tarea en un hilo separado para evitar bloquear el Event Loop principal.
 */
if (!parentPort) {
  process.exit(1);
}

// Log inicial para verificar que el worker inició correctamente
console.log('[Worker] Image Converter Worker started');
if (process.env.TS_NODE_TRANSPILE_ONLY) {
  console.log('[Worker] Transpile only enabled');
}

parentPort.on('message', async (data) => {
  const { type, pdfBuffer, ticketData, options } = data;
  
  try {
    if (type === 'GENERATE_TICKET') {
      // Importación dinámica para cargar canvas solo en este hilo
      const { generateTicketImage } = await import('../services/ticket-image-generator.service');
      const buffer = await generateTicketImage(ticketData, options);
      const transferList: ArrayBuffer[] = [];
      if (buffer && buffer.buffer instanceof ArrayBuffer) {
        transferList.push(buffer.buffer);
      }

      parentPort?.postMessage({ 
        success: true, 
        imageBuffer: buffer 
      }, transferList);
      return;
    }

    // Default: PDF to PNG conversion
    const { pdfToPng } = await import('pdf-to-png-converter');
    
    const finalOptions = {
      viewportScale: 2.0, 
      ...options
    };

    const pngPages = await pdfToPng(pdfBuffer, finalOptions);
    
    const transferList: ArrayBuffer[] = [];
    const formattedPages = pngPages.map(page => {
      if (page.content && page.content.buffer instanceof ArrayBuffer) {
        transferList.push(page.content.buffer);
      }
      return {
        ...page,
        content: page.content
      };
    });

    parentPort?.postMessage({ 
      success: true, 
      pngPages: formattedPages
    }, transferList);
  } catch (error: any) {
    parentPort?.postMessage({ 
      success: false, 
      error: error.message || 'Error interno en el worker de imagen' 
    });
  }
});
