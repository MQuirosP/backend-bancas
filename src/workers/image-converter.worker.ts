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
  const { pdfBuffer, options } = data;
  
  try {
    const { pdfToPng } = await import('pdf-to-png-converter');
    
    // DPI Estratégico: viewportScale = 2.0 equivale a ~144-150 DPI (base 72)
    // Esto reduce el uso de CPU a la mitad comparado con 300 DPI (scale 4.0)
    const finalOptions = {
      viewportScale: 2.0, 
      ...options
    };

    const pngPages = await pdfToPng(pdfBuffer, finalOptions);
    
    // Enviar resultado al hilo principal
    parentPort?.postMessage({ 
      success: true, 
      pngPages: pngPages.map(page => ({
        ...page,
        content: page.content // El Buffer se serializa automáticamente
      }))
    });
  } catch (error: any) {
    // Captura global de errores para no tumbar el worker inesperadamente
    parentPort?.postMessage({ 
      success: false, 
      error: error.message || 'Error interno en el worker de imagen' 
    });
  }
});
