/// <reference types="jest" />
import { updateCacheAfterMovement } from '../../src/domain/accounts/accounts.movements';
import { invalidateAccountStatementCache } from '../../src/utils/accountStatementCache';
import { CacheService } from '../../src/core/cache.service';
import { VendorCreditService } from '../../src/domain/credit/vendorCredit.service';

jest.mock('../../src/utils/accountStatementCache', () => ({
  invalidateAccountStatementCache: jest.fn(),
}));

jest.mock('../../src/core/cache.service', () => ({
  CacheService: {
    invalidateTag: jest.fn(),
  },
}));

jest.mock('../../src/domain/credit/vendorCredit.service', () => ({
  VendorCreditService: {
    updateBaseBalance: jest.fn().mockResolvedValue(undefined),
  },
}));

describe('updateCacheAfterMovement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('awaits account cache invalidation before resolving', async () => {
    let resolveStatement: (() => void) | undefined;
    let resolveVendorSummary: (() => void) | undefined;

    (invalidateAccountStatementCache as jest.Mock).mockImplementation(
      () => new Promise<void>((resolve) => { resolveStatement = resolve; })
    );
    (CacheService.invalidateTag as jest.Mock).mockImplementation(
      () => new Promise<void>((resolve) => { resolveVendorSummary = resolve; })
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
    expect(CacheService.invalidateTag).toHaveBeenCalledWith('vendedor:vendedor-1');
    resolveStatement?.();
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveVendorSummary?.();

    await pending;
    expect(settled).toBe(true);
    expect(VendorCreditService.updateBaseBalance).toHaveBeenCalledWith('vendedor-1');
  });

  it('does not invalidate a vendor summary tag or update credit balance for window or bank movements', async () => {
    (invalidateAccountStatementCache as jest.Mock).mockResolvedValue(undefined);

    await updateCacheAfterMovement('2026-06-25', 'ventana-1', null, 'banca-1');

    expect(CacheService.invalidateTag).not.toHaveBeenCalled();
    expect(VendorCreditService.updateBaseBalance).not.toHaveBeenCalled();
  });

  it('handles VendorCreditService.updateBaseBalance errors safely without throwing', async () => {
    (invalidateAccountStatementCache as jest.Mock).mockResolvedValue(undefined);
    (CacheService.invalidateTag as jest.Mock).mockResolvedValue(undefined);
    (VendorCreditService.updateBaseBalance as jest.Mock).mockRejectedValue(new Error('Redis connection error'));

    await expect(
      updateCacheAfterMovement('2026-06-25', 'ventana-1', 'vendedor-error', 'banca-1')
    ).resolves.not.toThrow();

    expect(VendorCreditService.updateBaseBalance).toHaveBeenCalledWith('vendedor-error');
  });
});
