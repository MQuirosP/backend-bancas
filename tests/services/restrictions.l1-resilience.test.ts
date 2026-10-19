import {
  readVersionTag,
  getOrSetRestrictionsListCache,
  getOrCompileVendorRules,
  bumpRestrictionsVersion,
} from '../../src/utils/restrictionCompiledCache';
import * as redisClient from '../../src/core/redisClient';

describe('Restrictions L1 & Resilience Optimization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('readVersionTag L1 caching and fallback', () => {
    it('should serve version tag from L1 RAM within TTL without hitting Redis repeatedly', async () => {
      const mockGet = jest.fn().mockResolvedValue('42');
      jest.spyOn(redisClient, 'isRedisAvailable').mockReturnValue(true);
      jest.spyOn(redisClient, 'getRedisClient').mockReturnValue({
        get: mockGet,
        mget: jest.fn(),
      } as any);

      // First call: hits Redis
      const tag1 = await readVersionTag('global');
      expect(tag1).toBe('42');
      expect(mockGet).toHaveBeenCalledTimes(1);

      // Second call immediately after: served from L1 RAM cache
      const tag2 = await readVersionTag('global');
      expect(tag2).toBe('42');
      expect(mockGet).toHaveBeenCalledTimes(1); // Still 1!
    });

    it('should fallback to last known version if Redis fails instead of returning null', async () => {
      const mockMget = jest.fn()
        .mockResolvedValueOnce(['5', '5'])
        .mockRejectedValueOnce(new Error('CircuitBreaker timeout: Redis took > 150ms'));

      jest.spyOn(redisClient, 'isRedisAvailable').mockReturnValue(true);
      jest.spyOn(redisClient, 'getRedisClient').mockReturnValue({
        get: jest.fn(),
        mget: mockMget,
      } as any);

      // 1. Initial success sets last known tag
      const tagSuccess = await readVersionTag('banca-test-fallback');
      expect(tagSuccess).toBe('5.5');

      // Invalidate L1 to force a read
      await bumpRestrictionsVersion('banca-test-fallback');

      // 2. Next call throws Redis timeout: returns fallback '5.5' instead of null!
      const tagFallback = await readVersionTag('banca-test-fallback');
      expect(tagFallback).toBe('5.5');
    });
  });

  describe('getOrSetRestrictionsListCache with SingleFlight and L1', () => {
    it('should deduplicate concurrent requests using SingleFlight and save to L1', async () => {
      jest.spyOn(redisClient, 'isRedisAvailable').mockReturnValue(false); // offline fallback
      const fetchFn = jest.fn().mockResolvedValue([{ id: 'rule-1', number: '12' }]);

      // Launch 3 concurrent calls
      const [res1, res2, res3] = await Promise.all([
        getOrSetRestrictionsListCache('banca-concurrent', 'query-hash-1', fetchFn, 300),
        getOrSetRestrictionsListCache('banca-concurrent', 'query-hash-1', fetchFn, 300),
        getOrSetRestrictionsListCache('banca-concurrent', 'query-hash-1', fetchFn, 300),
      ]);

      expect(res1).toEqual([{ id: 'rule-1', number: '12' }]);
      expect(res2).toEqual(res1);
      expect(res3).toEqual(res1);
      // Fetch function should have been called only ONCE due to SingleFlight
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('getOrCompileVendorRules with SingleFlight and L1', () => {
    it('should deduplicate concurrent compiles for the same vendor', async () => {
      jest.spyOn(redisClient, 'isRedisAvailable').mockReturnValue(false);
      const compileFn = jest.fn().mockResolvedValue({
        general: [{ id: 'g1' }],
        vendorSpecific: [{ id: 'v1' }],
      });

      const ctx = { bancaId: 'banca-1', ventanaId: 'ven-1', vendorId: 'user-1' };
      const [c1, c2] = await Promise.all([
        getOrCompileVendorRules(ctx, compileFn),
        getOrCompileVendorRules(ctx, compileFn),
      ]);

      expect(c1.general).toHaveLength(1);
      expect(c2.general).toHaveLength(1);
      expect(compileFn).toHaveBeenCalledTimes(1);
    });
  });
});
