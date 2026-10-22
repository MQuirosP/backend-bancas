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
      const { generateTicketImage } = await import('../domain/ticket/ticket-image-generator.service');
      const buffer = await generateTicketImage(ticketData, options);
      const transferList: ArrayBuffer[] = [];
      if (buffer && buffer.buffer instanceof ArrayBuffer) {
        transferList.push(buffer.buffer);
      }

      try {
        parentPort?.postMessage({ 
          success: true, 
          imageBuffer: buffer 
        }, transferList);
      } catch (_err) {
        parentPort?.postMessage({ 
          success: true, 
          imageBuffer: buffer 
        });
      }
      return;
    }

    if (type === 'GENERATE_LIST_IMAGE') {
      const { generateListImagePages } = await import('../domain/ticket/list-image-generator.service');
      const pages = await generateListImagePages(data.listData, options);
      parentPort?.postMessage({
        success: true,
        listPages: pages,
      });
      return;
    }

    throw new Error(`Tipo de tarea no soportado o en desuso: ${type}`);
  } catch (error: any) {
    parentPort?.postMessage({ 
      success: false, 
      error: error.message || 'Error interno en el worker de imagen' 
    });
  }
});
