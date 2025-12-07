import { CommissionResolver } from '../../../src/services/commission/CommissionResolver';
import { CommissionPolicyV1, CommissionMatchInput } from '../../../src/services/commission/types/CommissionTypes';

describe('CommissionResolver', () => {
  describe('resolveCommission', () => {
    it('should return commission from user policy when available', () => {
      const userPolicy: CommissionPolicyV1 = {
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

      const input: CommissionMatchInput = {
        loteriaId: 'loteria-1',
        betType: 'NUMERO',
        finalMultiplierX: 2,
        amount: 100,
      };

      const result = CommissionResolver.resolveCommission(input, {
        userPolicy,
        ventanaPolicy: null,
        bancaPolicy: null,
        listeroPolicy: null,
      });

      expect(result.commissionPercent).toBe(10);
      expect(result.commissionAmount).toBe(10);
      expect(result.commissionOrigin).toBe('USER');
      expect(result.commissionRuleId).toBe('rule-1');
    });

    it('should fallback to ventana policy when user policy is null', () => {
      const ventanaPolicy: CommissionPolicyV1 = {
        version: 1,
        effectiveFrom: null,
        effectiveTo: null,
        defaultPercent: 5,
        rules: [
          {
            id: 'ventana-rule-1',
            loteriaId: null,
            betType: null,
            percent: 8,
          },
        ],
      };

      const input: CommissionMatchInput = {
        loteriaId: 'loteria-1',
        betType: 'NUMERO',
        finalMultiplierX: 2,
        amount: 100,
      };

      const result = CommissionResolver.resolveCommission(input, {
        userPolicy: null,
        ventanaPolicy,
        bancaPolicy: null,
        listeroPolicy: null,
      });

      expect(result.commissionPercent).toBe(8);
      expect(result.commissionAmount).toBe(8);
      expect(result.commissionOrigin).toBe('VENTANA');
      expect(result.commissionRuleId).toBe('ventana-rule-1');
    });

    it('should fallback to banca policy when user and ventana policies are null', () => {
      const bancaPolicy: CommissionPolicyV1 = {
        version: 1,
        effectiveFrom: null,
        effectiveTo: null,
        defaultPercent: 5,
        rules: [],
      };

      const input: CommissionMatchInput = {
        loteriaId: 'loteria-1',
        betType: 'NUMERO',
        finalMultiplierX: 2,
        amount: 100,
      };

      const result = CommissionResolver.resolveCommission(input, {
        userPolicy: null,
        ventanaPolicy: null,
        bancaPolicy,
        listeroPolicy: null,
      });

      expect(result.commissionPercent).toBe(5);
      expect(result.commissionAmount).toBe(5);
      expect(result.commissionOrigin).toBe('BANCA');
      expect(result.commissionRuleId).toBeNull();
    });

    it('should return 0% when no policies are available', () => {
      const input: CommissionMatchInput = {
        loteriaId: 'loteria-1',
        betType: 'NUMERO',
        finalMultiplierX: 2,
        amount: 100,
      };

      const result = CommissionResolver.resolveCommission(input, {
        userPolicy: null,
        ventanaPolicy: null,
        bancaPolicy: null,
        listeroPolicy: null,
      });

      expect(result.commissionPercent).toBe(0);
      expect(result.commissionAmount).toBe(0);
      expect(result.commissionOrigin).toBeNull();
      expect(result.commissionRuleId).toBeNull();
    });

    it('should match rule by loteriaId when specified', () => {
      const userPolicy: CommissionPolicyV1 = {
        version: 1,
        effectiveFrom: null,
        effectiveTo: null,
        defaultPercent: 5,
        rules: [
          {
            id: 'rule-loteria-1',
            loteriaId: 'loteria-1',
            betType: null,
            percent: 15,
          },
          {
            id: 'rule-default',
            loteriaId: null,
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

      const result = CommissionResolver.resolveCommission(input, {
        userPolicy,
        ventanaPolicy: null,
        bancaPolicy: null,
        listeroPolicy: null,
      });

      expect(result.commissionPercent).toBe(15);
      expect(result.commissionRuleId).toBe('rule-loteria-1');
    });

    it('should match rule by betType when specified', () => {
      const userPolicy: CommissionPolicyV1 = {
        version: 1,
        effectiveFrom: null,
        effectiveTo: null,
        defaultPercent: 5,
        rules: [
          {
            id: 'rule-reventado',
            loteriaId: null,
            betType: 'REVENTADO',
            percent: 20,
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

      const result = CommissionResolver.resolveCommission(input, {
        userPolicy,
        ventanaPolicy: null,
        bancaPolicy: null,
        listeroPolicy: null,
      });

      expect(result.commissionPercent).toBe(20);
      expect(result.commissionRuleId).toBe('rule-reventado');
    });

    it('should match rule by multiplierRange when specified', () => {
      const userPolicy: CommissionPolicyV1 = {
        version: 1,
        effectiveFrom: null,
        effectiveTo: null,
        defaultPercent: 5,
        rules: [
          {
            id: 'rule-multiplier-2-5',
            loteriaId: null,
            betType: 'NUMERO',
            multiplierRange: { min: 2, max: 5 },
            percent: 12,
          },
          {
            id: 'rule-default',
            loteriaId: null,
            betType: null,
            percent: 10,
          },
        ],
      };

      const input: CommissionMatchInput = {
        loteriaId: 'loteria-1',
        betType: 'NUMERO',
        finalMultiplierX: 3,
        amount: 100,
      };

      const result = CommissionResolver.resolveCommission(input, {
        userPolicy,
        ventanaPolicy: null,
        bancaPolicy: null,
        listeroPolicy: null,
      });

      expect(result.commissionPercent).toBe(12);
      expect(result.commissionRuleId).toBe('rule-multiplier-2-5');
    });
  });

  describe('resolveListeroCommission', () => {
    it('should return commission from listero policy when available', () => {
      const listeroPolicy: CommissionPolicyV1 = {
        version: 1,
        effectiveFrom: null,
        effectiveTo: null,
        defaultPercent: 5,
        rules: [
          {
            id: 'listero-rule-1',
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

      const result = CommissionResolver.resolveListeroCommission(input, {
        userPolicy: null,
        ventanaPolicy: null,
        bancaPolicy: null,
        listeroPolicy,
      });

      expect(result.commissionPercent).toBe(7);
      expect(result.commissionAmount).toBe(7);
      expect(result.commissionOrigin).toBe('USER');
      expect(result.commissionRuleId).toBe('listero-rule-1');
    });

    it('should fallback to ventana policy when listero policy is null', () => {
      const ventanaPolicy: CommissionPolicyV1 = {
        version: 1,
        effectiveFrom: null,
        effectiveTo: null,
        defaultPercent: 5,
        rules: [
          {
            id: 'ventana-rule-1',
            loteriaId: null,
            betType: null,
            percent: 6,
          },
        ],
      };

      const input: CommissionMatchInput = {
        loteriaId: 'loteria-1',
        betType: 'NUMERO',
        finalMultiplierX: 2,
        amount: 100,
      };

      const result = CommissionResolver.resolveListeroCommission(input, {
        userPolicy: null,
        ventanaPolicy,
        bancaPolicy: null,
        listeroPolicy: null,
      });

      expect(result.commissionPercent).toBe(6);
      expect(result.commissionAmount).toBe(6);
      expect(result.commissionOrigin).toBe('VENTANA');
      expect(result.commissionRuleId).toBe('ventana-rule-1');
    });

    it('should NOT use user policy for listero commission', () => {
      const userPolicy: CommissionPolicyV1 = {
        version: 1,
        effectiveFrom: null,
        effectiveTo: null,
        defaultPercent: 5,
        rules: [
          {
            id: 'user-rule-1',
            loteriaId: null,
            betType: null,
            percent: 10,
          },
        ],
      };

      const ventanaPolicy: CommissionPolicyV1 = {
        version: 1,
        effectiveFrom: null,
        effectiveTo: null,
        defaultPercent: 5,
        rules: [],
      };

      const input: CommissionMatchInput = {
        loteriaId: 'loteria-1',
        betType: 'NUMERO',
        finalMultiplierX: 2,
        amount: 100,
      };

      const result = CommissionResolver.resolveListeroCommission(input, {
        userPolicy,
        ventanaPolicy,
        bancaPolicy: null,
        listeroPolicy: null,
      });

      // Debe usar ventanaPolicy (defaultPercent: 5), NO userPolicy (10)
      expect(result.commissionPercent).toBe(5);
      expect(result.commissionOrigin).toBe('VENTANA');
    });
  });
});

