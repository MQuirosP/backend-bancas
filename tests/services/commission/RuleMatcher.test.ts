import { findMatchingRule } from '../../../src/services/commission/utils/RuleMatcher';
import { CommissionPolicyV1, CommissionMatchInput } from '../../../src/services/commission/types/CommissionTypes';

describe('RuleMatcher', () => {
  describe('findMatchingRule', () => {
    it('should match rule by loteriaId', () => {
      const policy: CommissionPolicyV1 = {
        version: 1,
        effectiveFrom: null,
        effectiveTo: null,
        defaultPercent: 5,
        rules: [
          {
            id: 'rule-loteria-1',
            loteriaId: 'loteria-1',
            betType: null,
            percent: 10,
          },
          {
            id: 'rule-default',
            loteriaId: null,
            betType: null,
            percent: 7,
          },
        ],
      };

      const input: CommissionMatchInput = {
        loteriaId: 'loteria-1',
        betType: 'NUMERO',
        finalMultiplierX: 2,
        amount: 100,
      };

      const result = findMatchingRule(policy, input);

      expect(result.percent).toBe(10);
      expect(result.ruleId).toBe('rule-loteria-1');
    });

    it('should match rule by betType', () => {
      const policy: CommissionPolicyV1 = {
        version: 1,
        effectiveFrom: null,
        effectiveTo: null,
        defaultPercent: 5,
        rules: [
          {
            id: 'rule-reventado',
            loteriaId: null,
            betType: 'REVENTADO',
            percent: 15,
          },
          {
            id: 'rule-numero',
            loteriaId: null,
            betType: 'NUMERO',
            percent: 10,
          },
        ],
      };

      const input: CommissionMatchInput = {
        loteriaId: 'loteria-1',
        betType: 'REVENTADO',
        finalMultiplierX: 2,
        amount: 100,
      };

      const result = findMatchingRule(policy, input);

      expect(result.percent).toBe(15);
      expect(result.ruleId).toBe('rule-reventado');
    });

    it('should match rule by multiplierRange', () => {
      const policy: CommissionPolicyV1 = {
        version: 1,
        effectiveFrom: null,
        effectiveTo: null,
        defaultPercent: 5,
        rules: [
          {
            id: 'rule-mult-2-5',
            loteriaId: null,
            betType: 'NUMERO',
            multiplierRange: { min: 2, max: 5 },
            percent: 12,
          },
          {
            id: 'rule-default',
            loteriaId: null,
            betType: null,
            percent: 7,
          },
        ],
      };

      const input: CommissionMatchInput = {
        loteriaId: 'loteria-1',
        betType: 'NUMERO',
        finalMultiplierX: 3,
        amount: 100,
      };

      const result = findMatchingRule(policy, input);

      expect(result.percent).toBe(12);
      expect(result.ruleId).toBe('rule-mult-2-5');
    });

    it('should not match multiplierRange for REVENTADO betType', () => {
      const policy: CommissionPolicyV1 = {
        version: 1,
        effectiveFrom: null,
        effectiveTo: null,
        defaultPercent: 5,
        rules: [
          {
            id: 'rule-mult-2-5',
            loteriaId: null,
            betType: 'NUMERO',
            multiplierRange: { min: 2, max: 5 },
            percent: 12,
          },
          {
            id: 'rule-default',
            loteriaId: null,
            betType: null,
            percent: 7,
          },
        ],
      };

      const input: CommissionMatchInput = {
        loteriaId: 'loteria-1',
        betType: 'REVENTADO',
        finalMultiplierX: 3,
        amount: 100,
      };

      const result = findMatchingRule(policy, input);

      // Debe usar defaultPercent porque REVENTADO no coincide con multiplierRange
      expect(result.percent).toBe(7);
      expect(result.ruleId).toBeNull();
    });

    it('should return defaultPercent when no rule matches', () => {
      const policy: CommissionPolicyV1 = {
        version: 1,
        effectiveFrom: null,
        effectiveTo: null,
        defaultPercent: 5,
        rules: [
          {
            id: 'rule-loteria-2',
            loteriaId: 'loteria-2',
            betType: null,
            percent: 10,
          },
        ],
      };

      const input: CommissionMatchInput = {
        loteriaId: 'loteria-1',
        betType: 'NUMERO',
        finalMultiplierX: 2,
        amount: 100,
      };

      const result = findMatchingRule(policy, input);

      expect(result.percent).toBe(5);
      expect(result.ruleId).toBeNull();
    });

    it('should match most specific rule first', () => {
      const policy: CommissionPolicyV1 = {
        version: 1,
        effectiveFrom: null,
        effectiveTo: null,
        defaultPercent: 5,
        rules: [
          {
            id: 'rule-specific',
            loteriaId: 'loteria-1',
            betType: 'NUMERO',
            multiplierRange: { min: 2, max: 5 },
            percent: 15,
          },
          {
            id: 'rule-loteria',
            loteriaId: 'loteria-1',
            betType: null,
            percent: 10,
          },
          {
            id: 'rule-default',
            loteriaId: null,
            betType: null,
            percent: 7,
          },
        ],
      };

      const input: CommissionMatchInput = {
        loteriaId: 'loteria-1',
        betType: 'NUMERO',
        finalMultiplierX: 3,
        amount: 100,
      };

      const result = findMatchingRule(policy, input);

      // Debe usar la regla más específica (la primera que coincide)
      expect(result.percent).toBe(15);
      expect(result.ruleId).toBe('rule-specific');
    });
  });
});


