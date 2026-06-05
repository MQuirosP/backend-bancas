/// <reference types="jest" />
import { AccountStatementSyncService } from '../../src/api/v1/services/accounts/accounts.sync.service';
import prisma from '../../src/core/prismaClient';

jest.mock('../../src/core/prismaClient', () => ({
  __esModule: true,
  default: {
    ticket: {
      findFirst: jest.fn(),
    },
    accountPayment: {
      findFirst: jest.fn(),
    },
    accountStatement: {
      findFirst: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    ventana: {
      findUnique: jest.fn(),
    },
  },
}));

describe('AccountStatementSyncService.resolveHistoricalVentanaAndBanca', () => {
  const vendedorId = 'vendedor-123';
  const date = new Date('2026-06-02T00:00:00Z');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('1. should resolve from ticket on date if found', async () => {
    (prisma.ticket.findFirst as jest.Mock).mockResolvedValue({
      ventanaId: 'ventana-ticket',
      bancaId: 'banca-ticket',
    });

    const result = await (AccountStatementSyncService as any).resolveHistoricalVentanaAndBanca(vendedorId, date);

    expect(prisma.ticket.findFirst).toHaveBeenCalledWith({
      where: { vendedorId, businessDate: date, deletedAt: null },
      select: { ventanaId: true, bancaId: true },
    });
    expect(result).toEqual({
      ventanaId: 'ventana-ticket',
      bancaId: 'banca-ticket',
    });
    // Should not call subsequent resolvers
    expect(prisma.accountPayment.findFirst).not.toHaveBeenCalled();
  });

  it('2. should resolve from payment on date if no ticket is found', async () => {
    (prisma.ticket.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.accountPayment.findFirst as jest.Mock).mockResolvedValue({
      ventanaId: 'ventana-payment',
      bancaId: 'banca-payment',
    });

    const result = await (AccountStatementSyncService as any).resolveHistoricalVentanaAndBanca(vendedorId, date);

    expect(prisma.ticket.findFirst).toHaveBeenCalled();
    expect(prisma.accountPayment.findFirst).toHaveBeenCalledWith({
      where: { vendedorId, date, isReversed: false },
      select: { ventanaId: true, bancaId: true },
    });
    expect(result).toEqual({
      ventanaId: 'ventana-payment',
      bancaId: 'banca-payment',
    });
    // Should not call subsequent resolvers
    expect(prisma.accountStatement.findFirst).not.toHaveBeenCalled();
  });

  it('3. should resolve from existing account statement on date if no ticket or payment', async () => {
    (prisma.ticket.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.accountPayment.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.accountStatement.findFirst as jest.Mock).mockImplementation((args: any) => {
      // First call is for existing statement (on date)
      if (args.where.date && !args.where.date.lt) {
        return Promise.resolve({
          ventanaId: 'ventana-existing-stmt',
          bancaId: 'banca-existing-stmt',
        });
      }
      return Promise.resolve(null);
    });

    const result = await (AccountStatementSyncService as any).resolveHistoricalVentanaAndBanca(vendedorId, date);

    expect(prisma.ticket.findFirst).toHaveBeenCalled();
    expect(prisma.accountPayment.findFirst).toHaveBeenCalled();
    expect(prisma.accountStatement.findFirst).toHaveBeenCalledWith({
      where: { date, vendedorId },
      select: { ventanaId: true, bancaId: true },
    });
    expect(result).toEqual({
      ventanaId: 'ventana-existing-stmt',
      bancaId: 'banca-existing-stmt',
    });
  });

  it('4. should resolve from nearest previous account statement if no ticket, payment, or current statement', async () => {
    (prisma.ticket.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.accountPayment.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.accountStatement.findFirst as jest.Mock).mockImplementation((args: any) => {
      // First call (on date) returns null
      if (args.where.date && !args.where.date.lt) {
        return Promise.resolve(null);
      }
      // Second call (lt date) returns the previous statement
      if (args.where.date && args.where.date.lt) {
        return Promise.resolve({
          ventanaId: 'ventana-prev-stmt',
          bancaId: 'banca-prev-stmt',
        });
      }
      return Promise.resolve(null);
    });

    const result = await (AccountStatementSyncService as any).resolveHistoricalVentanaAndBanca(vendedorId, date);

    expect(prisma.ticket.findFirst).toHaveBeenCalled();
    expect(prisma.accountPayment.findFirst).toHaveBeenCalled();
    // Verify first call
    expect(prisma.accountStatement.findFirst).toHaveBeenNthCalledWith(1, {
      where: { date, vendedorId },
      select: { ventanaId: true, bancaId: true },
    });
    // Verify second call (previous statement search)
    expect(prisma.accountStatement.findFirst).toHaveBeenNthCalledWith(2, {
      where: { date: { lt: date }, vendedorId },
      orderBy: { date: 'desc' },
      select: { ventanaId: true, bancaId: true },
    });
    expect(result).toEqual({
      ventanaId: 'ventana-prev-stmt',
      bancaId: 'banca-prev-stmt',
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('5. should fall back to current user profile and resolve its window/banca if nothing else found', async () => {
    (prisma.ticket.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.accountPayment.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.accountStatement.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      ventanaId: 'ventana-profile',
    });
    (prisma.ventana.findUnique as jest.Mock).mockResolvedValue({
      bancaId: 'banca-profile',
    });

    const result = await (AccountStatementSyncService as any).resolveHistoricalVentanaAndBanca(vendedorId, date);

    expect(prisma.ticket.findFirst).toHaveBeenCalled();
    expect(prisma.accountPayment.findFirst).toHaveBeenCalled();
    expect(prisma.accountStatement.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: vendedorId },
      select: { ventanaId: true },
    });
    expect(prisma.ventana.findUnique).toHaveBeenCalledWith({
      where: { id: 'ventana-profile' },
      select: { bancaId: true },
    });
    expect(result).toEqual({
      ventanaId: 'ventana-profile',
      bancaId: 'banca-profile',
    });
  });

  it('6. should return empty object if user profile lacks a window', async () => {
    (prisma.ticket.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.accountPayment.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.accountStatement.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      ventanaId: null,
    });

    const result = await (AccountStatementSyncService as any).resolveHistoricalVentanaAndBanca(vendedorId, date);

    expect(result).toEqual({});
    expect(prisma.ventana.findUnique).not.toHaveBeenCalled();
  });
});
