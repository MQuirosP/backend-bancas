/// <reference types="jest" />
import { registerPayment, reversePayment } from '../../src/domain/accounts/accounts.movements';
import prisma from '../../src/core/prismaClient';
import { AccountStatementSyncService } from '../../src/domain/accounts/accounts.sync.service';

jest.mock('../../src/core/prismaClient', () => {
  return {
    __esModule: true,
    default: {
      accountPayment: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      accountStatement: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
      },
      ventana: {
        findUnique: jest.fn(),
      },
      $transaction: jest.fn(),
      $executeRaw: jest.fn(),
    },
  };
});

jest.mock('../../src/domain/accounts/accounts.sync.service', () => ({
  AccountStatementSyncService: {
    propagateBalanceChange: jest.fn().mockResolvedValue(undefined),
    syncDayStatement: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../src/utils/accountStatementCache', () => ({
  invalidateAccountStatementCache: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/core/cache.service', () => ({
  CacheService: {
    invalidateTag: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../src/core/activity.service', () => ({
  __esModule: true,
  default: {
    log: jest.fn().mockResolvedValue(undefined),
  },
}));

describe('registerPayment & reversePayment atomic execution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('updates AccountStatement atomically in the transaction without awaiting background propagation', async () => {
    const mockStatement = {
      id: 'statement-uuid-1',
      date: new Date('2026-10-18T00:00:00Z'),
      month: '2026-10',
      ventanaId: 'ventana-1',
      vendedorId: null,
      bancaId: 'banca-1',
      ticketCount: 10,
      totalSales: 1000,
      totalPayouts: 200,
      listeroCommission: 100,
      balance: 700,
      totalPaid: 100,
      totalCollected: 0,
      remainingBalance: 600,
      accumulatedBalance: 600,
      isSettled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockPayment = {
      id: 'payment-uuid-1',
      accountStatementId: mockStatement.id,
      date: mockStatement.date,
      month: mockStatement.month,
      time: '12:00',
      ventanaId: mockStatement.ventanaId,
      vendedorId: null,
      bancaId: mockStatement.bancaId,
      amount: 200,
      type: 'payment',
      method: 'cash',
      notes: 'CIERRE DE SEMANA',
      isFinal: false,
      idempotencyKey: 'idemp-1',
      paidById: 'admin-1',
      paidByName: 'Admin',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    (prisma.accountStatement.findFirst as jest.Mock).mockResolvedValue(mockStatement);
    (prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        accountStatement: {
          findUnique: jest.fn().mockResolvedValue(mockStatement),
          update: jest.fn().mockResolvedValue({
            ...mockStatement,
            totalPaid: 300,
            remainingBalance: 800,
            accumulatedBalance: 800,
          }),
        },
        accountPayment: {
          create: jest.fn().mockResolvedValue(mockPayment),
        },
      };
      return callback(tx);
    });

    const result = await registerPayment({
      date: '2026-10-18',
      time: '12:00',
      ventanaId: 'ventana-1',
      amount: 200,
      type: 'payment',
      method: 'cash',
      notes: 'CIERRE DE SEMANA',
      idempotencyKey: 'idemp-1',
      paidById: 'admin-1',
      paidByName: 'Admin',
    });

    // 1. Transaction was called with 5000ms timeout
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: 5000, isolationLevel: 'ReadCommitted' })
    );

    // 2. Statement was updated atomically with correct sums
    expect(result.statement.totalPaid).toBe(300);
    expect(result.statement.accumulatedBalance).toBe(800);
    expect(result.payment.id).toBe('payment-uuid-1');

    // 3. propagateBalanceChange was NOT called synchronously before registerPayment returned
    // (it is dispatched via setImmediate)
    expect(AccountStatementSyncService.propagateBalanceChange).not.toHaveBeenCalled();

    // 4. After tick, setImmediate triggers background propagation
    await new Promise((resolve) => setImmediate(resolve));
    expect(AccountStatementSyncService.propagateBalanceChange).toHaveBeenCalledWith(
      expect.any(Date),
      'ventana',
      'ventana-1'
    );
  });

  it('reverses payment and updates AccountStatement atomically without blocking on propagation', async () => {
    const mockStatement = {
      id: 'statement-uuid-2',
      date: new Date('2026-10-18T00:00:00Z'),
      month: '2026-10',
      ventanaId: 'ventana-1',
      vendedorId: null,
      bancaId: 'banca-1',
      ticketCount: 10,
      totalSales: 1000,
      totalPayouts: 200,
      listeroCommission: 100,
      balance: 700,
      totalPaid: 300,
      totalCollected: 0,
      remainingBalance: 800,
      accumulatedBalance: 800,
      isSettled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockPayment: any = {
      id: 'payment-uuid-2',
      accountStatementId: mockStatement.id,
      accountStatement: mockStatement,
      date: mockStatement.date,
      month: mockStatement.month,
      time: '12:00',
      ventanaId: mockStatement.ventanaId,
      vendedorId: null,
      bancaId: mockStatement.bancaId,
      amount: 200,
      type: 'payment',
      method: 'cash',
      isReversed: false,
      reversedAt: null,
      reversedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    (prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        accountStatement: {
          findUnique: jest.fn().mockResolvedValue(mockStatement),
          update: jest.fn().mockResolvedValue({
            ...mockStatement,
            totalPaid: 100,
            remainingBalance: 600,
            accumulatedBalance: 600,
          }),
        },
        accountPayment: {
          update: jest.fn().mockResolvedValue({
            ...mockPayment,
            isReversed: true,
          }),
        },
      };
      return callback(tx);
    });

    const result = await reversePayment(mockPayment, 'admin-1', 'Error de digitación');

    expect(result.statement.totalPaid).toBe(100);
    expect(result.statement.accumulatedBalance).toBe(600);
    expect(result.payment.isReversed).toBe(true);

    expect(AccountStatementSyncService.propagateBalanceChange).not.toHaveBeenCalled();

    await new Promise((resolve) => setImmediate(resolve));
    expect(AccountStatementSyncService.propagateBalanceChange).toHaveBeenCalledWith(
      expect.any(Date),
      'ventana',
      'ventana-1'
    );
  });
});
