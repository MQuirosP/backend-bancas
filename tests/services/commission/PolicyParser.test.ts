import { parseCommissionPolicy } from '../../../src/services/commission/utils/PolicyParser';

describe('PolicyParser', () => {
  describe('parseCommissionPolicy', () => {
    it('should parse valid policy v1', () => {
      const policyJson = {
        version: 1,
        effectiveFrom: null,
        effectiveTo: null,
        defaultPercent: 5,
        rules: [
          {
            id: 'rule-1',
            loteriaId: null,
            betType: null,
            percent: 10,
          },
        ],
      };

      const result = parseCommissionPolicy(policyJson, 'USER');

      expect(result).not.toBeNull();
      expect(result?.version).toBe(1);
      expect(result?.defaultPercent).toBe(5);
      expect(result?.rules).toHaveLength(1);
      expect(result?.rules[0].id).toBe('rule-1');
    });

    it('should return null for invalid version', () => {
      const policyJson = {
        version: 2,
        defaultPercent: 5,
        rules: [],
      };

      const result = parseCommissionPolicy(policyJson, 'USER');

      expect(result).toBeNull();
    });

    it('should return null for missing defaultPercent', () => {
      const policyJson = {
        version: 1,
        rules: [],
      };

      const result = parseCommissionPolicy(policyJson, 'USER');

      expect(result).toBeNull();
    });

    it('should return null for invalid rules array', () => {
      const policyJson = {
        version: 1,
        defaultPercent: 5,
        rules: 'not-an-array',
      };

      const result = parseCommissionPolicy(policyJson, 'USER');

      expect(result).toBeNull();
    });

    it('should return null for policy not yet effective', () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const policyJson = {
        version: 1,
        effectiveFrom: futureDate.toISOString(),
        effectiveTo: null,
        defaultPercent: 5,
        rules: [],
      };

      const result = parseCommissionPolicy(policyJson, 'USER');

      expect(result).toBeNull();
    });

    it('should return null for expired policy', () => {
      const pastDate = new Date();
      pastDate.setFullYear(pastDate.getFullYear() - 1);

      const policyJson = {
        version: 1,
        effectiveFrom: null,
        effectiveTo: pastDate.toISOString(),
        defaultPercent: 5,
        rules: [],
      };

      const result = parseCommissionPolicy(policyJson, 'USER');

      expect(result).toBeNull();
    });

    it('should return null for null input', () => {
      const result = parseCommissionPolicy(null, 'USER');

      expect(result).toBeNull();
    });

    it('should return null for non-object input', () => {
      const result = parseCommissionPolicy('not-an-object', 'USER');

      expect(result).toBeNull();
    });

    it('should validate rule structure', () => {
      const policyJson = {
        version: 1,
        defaultPercent: 5,
        rules: [
          {
            id: 'rule-1',
            percent: 10,
          },
          {
            // Missing id
            percent: 15,
          },
        ],
      };

      const result = parseCommissionPolicy(policyJson, 'USER');

      expect(result).toBeNull();
    });
  });
});

