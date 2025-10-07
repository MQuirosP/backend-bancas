import prisma from '../core/prismaClient';
import { AppError } from '../core/errors';

export const RestrictionRuleRepository = {
  async getEffectiveRules(userId: string, ventanaId: string, bancaId: string) {
    const rules = await prisma.restrictionRule.findMany({
      where: {
        OR: [
          { userId, isDeleted: false },
          { ventanaId, isDeleted: false },
          { bancaId, isDeleted: false },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });

    // Prioridad: User > Ventana > Banca
    const userRule = rules.find(r => r.userId === userId);
    const ventanaRule = rules.find(r => r.ventanaId === ventanaId);
    const bancaRule = rules.find(r => r.bancaId === bancaId);

    return userRule || ventanaRule || bancaRule || null;
  },

  async validateTicket({
    userId,
    ventanaId,
    bancaId,
    jugadas,
    totalAmount,
  }: {
    userId: string;
    ventanaId: string;
    bancaId: string;
    jugadas: { number: string; amount: number }[];
    totalAmount: number;
  }) {
    const rule = await this.getEffectiveRules(userId, ventanaId, bancaId);
    if (!rule) return;

    // 🔸 Limite total por ticket
    if (rule.maxTotal && totalAmount > rule.maxTotal) {
      throw new AppError(`Ticket exceeds maxTotal (${rule.maxTotal})`, 400, 'RULE_VIOLATION');
    }

    // 🔸 Limite por jugada
    if (rule.maxAmount) {
      for (const j of jugadas) {
        if (j.amount > rule.maxAmount) {
          throw new AppError(`Play ${j.number} exceeds maxAmount (${rule.maxAmount})`, 400, 'RULE_VIOLATION');
        }
      }
    }

    // 🔸 Restricción por número específico
    if (rule.number) {
      const invalid = jugadas.find(j => j.number === rule.number);
      if (invalid) {
        throw new AppError(`Number ${rule.number} is restricted`, 400, 'RULE_VIOLATION');
      }
    }
  },
};

export default RestrictionRuleRepository;
