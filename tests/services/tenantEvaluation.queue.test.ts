/// <reference types="jest" />
import { TenantEvaluationQueue } from '../../src/domain/sorteo/tenantEvaluation.queue';

describe('TenantEvaluationQueue', () => {
  it('1. ejecuta operaciones de la misma banca en secuencia FIFO estricta', async () => {
    const executionOrder: string[] = [];

    const op1 = TenantEvaluationQueue.enqueue('banca-1', 'sorteo-1', async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      executionOrder.push('sorteo-1');
      return 'res-1';
    });

    const op2 = TenantEvaluationQueue.enqueue('banca-1', 'sorteo-2', async () => {
      executionOrder.push('sorteo-2');
      return 'res-2';
    });

    const [r1, r2] = await Promise.all([op1, op2]);
    expect(r1).toBe('res-1');
    expect(r2).toBe('res-2');
    expect(executionOrder).toEqual(['sorteo-1', 'sorteo-2']);
  });

  it('2. ejecuta operaciones de bancas distintas en paralelo sin bloquearse mutuamente', async () => {
    const startA = Date.now();
    let endA = 0;
    let endB = 0;

    const opA = TenantEvaluationQueue.enqueue('banca-A', 'sorteo-A', async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      endA = Date.now();
      return 'A';
    });

    const opB = TenantEvaluationQueue.enqueue('banca-B', 'sorteo-B', async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      endB = Date.now();
      return 'B';
    });

    await Promise.all([opA, opB]);

    // Ambas deben haber terminado aproximadamente al mismo tiempo (~60-90ms, no 120ms+)
    const totalDuration = Math.max(endA, endB) - startA;
    expect(totalDuration).toBeLessThan(120);
  });

  it('3. permite continuar el siguiente sorteo en la cola si el anterior arroja un error', async () => {
    const op1 = TenantEvaluationQueue.enqueue('banca-err', 'sorteo-fail', async () => {
      throw new Error('Error en sorteo anterior');
    });

    const op2 = TenantEvaluationQueue.enqueue('banca-err', 'sorteo-ok', async () => {
      return 'éxito';
    });

    await expect(op1).rejects.toThrow('Error en sorteo anterior');
    const res2 = await op2;
    expect(res2).toBe('éxito');
  });

  it('4. limpia la entrada del Map cuando la cola queda vacía para evitar memory leaks', async () => {
    const bancaId = 'banca-cleanup-test';
    const queueMap = (TenantEvaluationQueue as any).queues as Map<string, any>;

    await TenantEvaluationQueue.enqueue(bancaId, 'sorteo-c', async () => {
      expect(queueMap.has(bancaId)).toBe(true);
      return 'ok';
    });

    // Tras resolver, la entrada debe haber sido eliminada del mapa
    expect(queueMap.has(bancaId)).toBe(false);
  });
});
