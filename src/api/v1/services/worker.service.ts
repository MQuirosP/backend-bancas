import { Worker } from 'worker_threads';
import path from 'path';
import logger from '../../../core/logger';

/**
 * Determina la extensión correcta según si estamos en TS (desarrollo) o JS (dist)
 */
const extension = __filename.endsWith('.ts') ? '.ts' : '.js';
const workerFile = path.resolve(__dirname, `../../../workers/image-converter.worker${extension}`);

/**
 * Convierte un Buffer PDF a uno o más Buffers PNG usando un Worker Thread.
 * Libera el Event Loop principal de la carga pesada de CPU de la librería de imagen.
 * 
 * @param pdfBuffer El Buffer del PDF a convertir
 * @param options Opciones de conversión (viewportScale, quality, etc.)
 * @returns Promesa que resuelve a un array de páginas con sus contenidos en Buffer
 */
export async function convertPdfToPng(pdfBuffer: Uint8Array, options: any = {}): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    // Si estamos en desarrollo (.ts), necesitamos registrar ts-node para el worker
    const workerOptions: any = extension === '.ts' 
      ? { 
          execArgv: ['-r', 'ts-node/register'],
          env: { 
            ...process.env, 
            TS_NODE_TRANSPILE_ONLY: 'true'
          }
        } 
      : {};

    logger.info({
      layer: 'worker-service',
      action: 'WORKER_SPAWNING_V3',
      payload: { 
        workerFile, 
        extension, 
        hasExecArgv: !!workerOptions.execArgv,
        envKeys: workerOptions.env ? Object.keys(workerOptions.env).length : 0,
        pdfSize: pdfBuffer.length
      }
    });

    let worker: Worker;
    try {
      worker = new Worker(workerFile, workerOptions);
    } catch (err: any) {
      logger.error({
        layer: 'worker-service',
        action: 'WORKER_SPAWN_ERROR',
        payload: { error: err.message, stack: err.stack }
      });
      return reject(err);
    }

    const onMessage = (data: any) => {
      if (data.success) {
        const duration = Date.now() - startTime;
        logger.info({
          layer: 'worker-service',
          action: 'IMAGE_CONVERSION_SUCCESS',
          payload: { 
            pages: data.pngPages.length,
            durationMs: duration
          }
        });
        resolve(data.pngPages);
      } else {
        logger.error({
          layer: 'worker-service',
          action: 'IMAGE_CONVERSION_WORKER_ERROR',
          payload: { error: data.error }
        });
        reject(new Error(data.error));
      }
      cleanup();
    };

    const onError = (err: any) => {
      logger.error({
        layer: 'worker-service',
        action: 'IMAGE_CONVERSION_FATAL_ERROR',
        payload: { error: err.message }
      });
      reject(err);
      cleanup();
    };

    const onExit = (code: number) => {
      if (code !== 0) {
        reject(new Error(`Worker de imagen finalizó con código de error ${code}`));
      }
      cleanup();
    };

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;

      // Limpiar listeners para evitar fugas de memoria
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
      
      // Asegurar que el thread se cierre inmediatamente liberando memoria
      worker.terminate().catch(err => {
        logger.warn({
          layer: 'worker-service',
          action: 'WORKER_TERMINATE_ERROR',
          payload: { error: err.message }
        });
      });
    };

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);

    // Iniciar la tarea
    worker.postMessage({ pdfBuffer, options });
  });
}

/**
 * Interface para el servicio de workers
 */
export const WorkerService = {
  convertPdfToPng
};
