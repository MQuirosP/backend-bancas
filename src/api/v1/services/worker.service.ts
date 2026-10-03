import { Worker } from 'worker_threads';
import path from 'path';
import logger from '../../../core/logger';

/**
 * Determina la extensión correcta según si estamos en TS (desarrollo) o JS (dist)
 */
const extension = __filename.endsWith('.ts') ? '.ts' : '.js';
const workerFile = path.resolve(__dirname, `../../../workers/image-converter.worker${extension}`);

/**
 * Gestor dedicado de Worker Thread con cola y ciclo de vida resiliente.
 */
class DedicatedWorkerRunner {
  private worker: Worker | null = null;
  private isBusy = false;
  private queue: Array<{
    type: string;
    payload: any;
    transferList?: ArrayBuffer[];
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    startTime: number;
  }> = [];

  constructor(public readonly name: string) {}

  private getOrCreateWorker(): Worker {
    if (this.worker) return this.worker;

    const workerOptions: any = extension === '.ts'
      ? {
          execArgv: ['-r', 'ts-node/register'],
          env: {
            ...process.env,
            TS_NODE_TRANSPILE_ONLY: 'true',
          },
        }
      : {};

    logger.info({
      layer: 'worker-service',
      action: 'WORKER_INIT_PERSISTENT',
      payload: { workerName: this.name, workerFile, extension },
    });

    this.worker = new Worker(workerFile, workerOptions);

    this.worker.on('message', (data: any) => {
      this.isBusy = false;
      const currentTask = this.queue.shift();
      if (!currentTask) return;

      if (data.success) {
        const duration = Date.now() - currentTask.startTime;
        logger.info({
          layer: 'worker-service',
          action: 'WORKER_TASK_SUCCESS',
          payload: {
            workerName: this.name,
            type: currentTask.type,
            durationMs: duration,
            queueRemaining: this.queue.length,
            resultSize: data.pngPages?.length || data.imageBuffer?.length || 0,
          },
        });
        currentTask.resolve(data.pngPages || data.imageBuffer);
      } else {
        logger.error({
          layer: 'worker-service',
          action: 'IMAGE_CONVERSION_WORKER_ERROR',
          payload: { workerName: this.name, error: data.error },
        });
        currentTask.reject(new Error(data.error));
      }

      this.processNextTask();
    });

    this.worker.on('error', (err) => {
      logger.error({
        layer: 'worker-service',
        action: 'WORKER_FATAL_ERROR',
        payload: { workerName: this.name, error: err.message, stack: err.stack },
      });

      while (this.queue.length > 0) {
        const task = this.queue.shift();
        task?.reject(err);
      }

      this.worker = null;
      this.isBusy = false;
    });

    this.worker.on('exit', (code) => {
      if (code !== 0) {
        logger.warn({
          layer: 'worker-service',
          action: 'WORKER_EXITED_UNEXPECTEDLY',
          payload: { workerName: this.name, code },
        });
      }

      if (this.isBusy && this.queue.length > 0) {
        const crashedTask = this.queue.shift();
        crashedTask?.reject(
          new Error(
            `Worker thread (${this.name}) terminated unexpectedly (exit code ${code}) while processing task ${crashedTask.type}`
          )
        );
      }

      this.worker = null;
      this.isBusy = false;

      if (this.queue.length > 0) {
        this.getOrCreateWorker();
        this.processNextTask();
      }
    });

    return this.worker;
  }

  private processNextTask() {
    if (this.isBusy || this.queue.length === 0) return;

    const worker = this.getOrCreateWorker();
    const nextTask = this.queue[0];
    this.isBusy = true;

    try {
      worker.postMessage(
        {
          type: nextTask.type,
          ...nextTask.payload,
        },
        nextTask.transferList || []
      );
    } catch (_err) {
      worker.postMessage({
        type: nextTask.type,
        ...nextTask.payload,
      });
    }
  }

  public execute<T>(
    type: string,
    payload: any,
    transferList?: ArrayBuffer[]
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        type,
        payload,
        transferList,
        resolve,
        reject,
        startTime: Date.now(),
      });
      this.processNextTask();
    });
  }

  public async terminate(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
      this.isBusy = false;
    }
  }
}

// ============================================================================
// TRABAJADORES SEGREGADOS: Hilos dedicados independientes para Tickets vs PDFs
// ============================================================================
const ticketWorker = new DedicatedWorkerRunner('ticket-render');
const pdfWorker = new DedicatedWorkerRunner('pdf-converter');

/**
 * Convierte un Buffer PDF a uno o más Buffers PNG usando un Worker Thread exclusivo de PDFs.
 */
export async function convertPdfToPng(pdfBuffer: Uint8Array, options: any = {}): Promise<any[]> {
  const transferList: ArrayBuffer[] = [];
  if (pdfBuffer.buffer instanceof ArrayBuffer) {
    transferList.push(pdfBuffer.buffer);
  }
  return pdfWorker.execute<any[]>('PDF_TO_PNG', { pdfBuffer, options }, transferList);
}

/**
 * Genera una imagen de ticket usando el Worker Thread exclusivo de Tickets.
 */
export async function generateTicketImage(ticketData: any, options: any = {}): Promise<Buffer> {
  return ticketWorker.execute<Buffer>('GENERATE_TICKET', { ticketData, options });
}

/**
 * Precalienta el isolate de V8 y las dependencias Cairo / Canvas de forma anticipada.
 */
let isWarmedUp = false;
export async function warmupWorkers(): Promise<void> {
  if (isWarmedUp) return;
  const start = Date.now();
  logger.info({
    layer: 'worker-service',
    action: 'WORKER_WARMUP_START',
  });

  const dummyTicket = {
    ticket: {
      id: '00000000-0000-0000-0000-000000000000',
      ticketNumber: 'WARMUP',
      totalAmount: 100,
      clienteNombre: 'WARMUP',
      createdAt: new Date(),
      isActive: true,
      printCount: 0,
      jugadas: [
        { type: 'NUMERO', number: '00', amount: 100, finalMultiplierX: 85 },
      ],
      sorteo: {
        name: 'WARMUP',
        scheduledAt: new Date(),
        loteria: { name: 'WARMUP' },
      },
      vendedor: {
        name: 'WARMUP',
        code: 'W01',
        printName: 'WARMUP',
        printPhone: '0000-0000',
        printBarcode: true,
        printFooter: 'WARMUP',
      },
      ventana: {
        name: 'WARMUP',
        printName: 'WARMUP',
        printPhone: '0000-0000',
        printBarcode: true,
        printFooter: 'WARMUP',
      },
    },
  };

  try {
    await generateTicketImage(dummyTicket, { width: 220, scale: 2 });
    isWarmedUp = true;
    logger.info({
      layer: 'worker-service',
      action: 'WORKER_WARMUP_SUCCESS',
      payload: { durationMs: Date.now() - start },
    });
  } catch (error: any) {
    logger.warn({
      layer: 'worker-service',
      action: 'WORKER_WARMUP_WARN',
      payload: { error: error.message },
    });
  }
}

/**
 * Interface para el servicio de workers
 */
export const WorkerService = {
  convertPdfToPng,
  generateTicketImage,
  warmupWorkers,
};
