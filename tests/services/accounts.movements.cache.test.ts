/// <reference types="jest" />
import { updateCacheAfterMovement } from '../../src/domain/accounts/accounts.movements';
import { invalidateAccountStatementCache } from '../../src/utils/accountStatementCache';

jest.mock('../../src/utils/accountStatementCache', () => ({
  invalidateAccountStatementCache: jest.fn(),
}));

describe('updateCacheAfterMovement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('awaits account cache invalidation before resolving', async () => {
    let resolveStatement: (() => void) | undefined;

    (invalidateAccountStatementCache as jest.Mock).mockImplementation(
      () => new Promise<void>((resolve) => { resolveStatement = resolve; })
    );

    const pending = updateCacheAfterMovement('2026-06-25', 'ventana-1', 'vendedor-1', 'banca-1');

    let settled = false;
    Promise.resolve(pending).then(() => {
      settled = true;
    });

    await Promise.resolve();

    expect(settled).toBe(false);
    expect(invalidateAccountStatementCache).toHaveBeenCalledWith({
      date: '2026-06-25',
      ventanaId: 'ventana-1',
      vendedorId: 'vendedor-1',
      bancaId: 'banca-1',
    });
    resolveStatement?.();

    await pending;
    expect(settled).toBe(true);
  });
});
