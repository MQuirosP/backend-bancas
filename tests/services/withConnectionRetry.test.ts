import { isConnectionError, isTransientDbConnectionError, withConnectionRetry } from '../../src/core/withConnectionRetry';

describe('withConnectionRetry & isConnectionError', () => {
  it('should recognize ECONNABORTED as transient connection error', () => {
    const err = new Error('read ECONNABORTED');
    expect(isConnectionError(err)).toBe(true);
    expect(isTransientDbConnectionError(err)).toBe(true);
  });

  it('should recognize "Client has encountered a connection error and is not queryable"', () => {
    const err = new Error('Client has encountered a connection error and is not queryable');
    expect(isConnectionError(err)).toBe(true);
    expect(isTransientDbConnectionError(err)).toBe(true);
  });

  it('should recognize P2024 as transient connection error', () => {
    const err: any = new Error('Timed out fetching a new connection from the pool');
    err.code = 'P2024';
    expect(isConnectionError(err)).toBe(true);
  });

  it('should retry transient errors and succeed', async () => {
    let attempts = 0;
    const result = await withConnectionRetry(async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('read ECONNABORTED');
      }
      return 'success';
    }, { maxRetries: 3, backoffMinMs: 10, backoffMaxMs: 50 });

    expect(attempts).toBe(2);
    expect(result).toBe('success');
  });

  it('should not retry logical errors', async () => {
    let attempts = 0;
    await expect(
      withConnectionRetry(async () => {
        attempts++;
        const err: any = new Error('Unique constraint failed');
        err.code = 'P2002';
        throw err;
      }, { maxRetries: 3, backoffMinMs: 10, backoffMaxMs: 50 })
    ).rejects.toThrow('Unique constraint failed');

    expect(attempts).toBe(1);
  });
});
