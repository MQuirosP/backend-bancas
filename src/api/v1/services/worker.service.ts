import { Worker } from 'worker_threads';
import path from 'path';
import logger from '../../../core/logger';

/**
 * Determina la extensión correcta según si estamos en TS (desarrollo) o JS (dist)
 */
const extension = __filename.endsWith('.ts') ? '.ts' : '.js';
const workerFile = path.resolve(__dirname, `../../../workers/image-converter.worker${extension}`);

//  SINGLETON WORKER: Mantener un único hilo vivo para evitar crashes por terminate() constante
let globalWorker: Worker | null = null;
let isWorkerBusy = false;
const workerQueue: { 
  pdfBuffer: Uint8Array; 
  options: any; 
  resolve: (value: any) => void; 
  reject: (reason?: any) => void;
  startTime: number;
}[] = [];

/**
 * Inicializa o recupera el worker global
 */
function getOrCreateWorker(): Worker {
  if (globalWorker) return globalWorker;

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
    action: 'WORKER_INIT_PERSISTENT',
    payload: { workerFile, extension }
  });

  globalWorker = new Worker(workerFile, workerOptions);

  globalWorker.on('message', (data: any) => {
    isWorkerBusy = false;
    const currentTask = workerQueue.shift();
    if (!currentTask) return;

    if (data.success) {
      const duration = Date.now() - currentTask.startTime;
      logger.info({
        layer: 'worker-service',
        action: 'IMAGE_CONVERSION_SUCCESS',
        payload: { 
          pages: data.pngPages.length,
          durationMs: duration,
          queueRemaining: workerQueue.length
        }
      });
      currentTask.resolve(data.pngPages);
    } else {
      logger.error({
        layer: 'worker-service',
        action: 'IMAGE_CONVERSION_WORKER_ERROR',
        payload: { error: data.error }
      });
      currentTask.reject(new Error(data.error));
    }

    processNextTask();
  });

  globalWorker.on('error', (err) => {
    logger.error({
      layer: 'worker-service',
      action: 'WORKER_FATAL_ERROR',
      payload: { error: err.message, stack: err.stack }
    });
    
    // Rechazar todas las tareas pendientes
    while (workerQueue.length > 0) {
      const task = workerQueue.shift();
      task?.reject(err);
    }

    globalWorker = null;
    isWorkerBusy = false;
  });

  globalWorker.on('exit', (code) => {
    if (code !== 0) {
      logger.warn({
        layer: 'worker-service',
        action: 'WORKER_EXITED_UNEXPECTEDLY',
        payload: { code }
      });
    }
    globalWorker = null;
    isWorkerBusy = false;
    
    // Si quedan tareas, reiniciar worker
    if (workerQueue.length > 0) {
      getOrCreateWorker();
      processNextTask();
    }
  });

  return globalWorker;
}

/**
 * Procesa la siguiente tarea en la cola
 */
function processNextTask() {
  if (isWorkerBusy || workerQueue.length === 0) return;

  const worker = getOrCreateWorker();
  const nextTask = workerQueue[0];
  
  isWorkerBusy = true;
  worker.postMessage({ 
    pdfBuffer: nextTask.pdfBuffer, 
    options: nextTask.options 
  });
}

/**
 * Convierte un Buffer PDF a uno o más Buffers PNG usando un Worker Thread Persistente.
 */
export async function convertPdfToPng(pdfBuffer: Uint8Array, options: any = {}): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    workerQueue.push({ 
      pdfBuffer, 
      options, 
      resolve, 
      reject,
      startTime 
    });

    processNextTask();
  });
}

/**
 * Interface para el servicio de workers
 */
export const WorkerService = {
  convertPdfToPng
};
