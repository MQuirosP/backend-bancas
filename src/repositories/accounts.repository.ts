import prisma from '../../../../core/prismaClient';
import { Account, LedgerEntry, BankDeposit, DailyBalanceSnapshot, OwnerType, LedgerType, ReferenceType, Prisma } from '@prisma/client';
import { AppError } from '../../../../core/errors';

export class AccountsRepository {
  /**
   * Obtener o crear cuenta
   */
  static async getOrCreateAccount(
    ownerType: OwnerType,
    ownerId: string,
    currency: string = 'CRC'
  ): Promise<Account> {
    return prisma.account.upsert({
      where: { ownerType_ownerId: { ownerType, ownerId } },
      update: {},
      create: {
        ownerType,
        ownerId,
        currency,
        balance: new Prisma.Decimal(0),
      },
    });
  }

  /**
   * Obtener cuenta por ID
   */
  static async getAccountById(accountId: string): Promise<Account | null> {
    return prisma.account.findUnique({
      where: { id: accountId },
    });
  }

  /**
   * Obtener cuenta con metadata
   */
  static async getAccountWithMetadata(accountId: string) {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
    });

    if (!account) return null;

    const entryCount = await prisma.ledgerEntry.count({
      where: { accountId },
    });

    const latestEntry = await prisma.ledgerEntry.findFirst({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
    });

    return {
      ...account,
      entryCount,
      latestEntry,
    };
  }

  /**
   * Listar cuentas con paginación
   */
  static async listAccounts(filters: {
    ownerType?: OwnerType;
    ownerId?: string;
    isActive?: boolean;
    page?: number;
    pageSize?: number;
  }) {
    const { ownerType, ownerId, isActive, page = 1, pageSize = 20 } = filters;

    const where: Prisma.AccountWhereInput = {};
    if (ownerType) where.ownerType = ownerType;
    if (ownerId) where.ownerId = ownerId;
    if (isActive !== undefined) where.isActive = isActive;

    const total = await prisma.account.count({ where });
    const items = await prisma.account.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    return {
      items,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * Actualizar cuenta
   */
  static async updateAccount(
    accountId: string,
    data: { balance?: Prisma.Decimal; isActive?: boolean }
  ) {
    return prisma.account.update({
      where: { id: accountId },
      data,
    });
  }

  /**
   * Agregar entrada ledger con transacción atómica
   */
  static async addLedgerEntry(
    accountId: string,
    entry: {
      date?: Date;
      type: LedgerType;
      valueSigned: Prisma.Decimal | number;
      referenceType?: ReferenceType;
      referenceId?: string;
      note?: string;
      requestId?: string;
      createdBy: string;
      reversalOfEntryId?: string;
    }
  ) {
    return prisma.$transaction(async (tx) => {
      const ledgerEntry = await tx.ledgerEntry.create({
        data: {
          accountId,
          type: entry.type,
          valueSigned: new Prisma.Decimal(entry.valueSigned),
          referenceType: entry.referenceType,
          referenceId: entry.referenceId,
          note: entry.note,
          requestId: entry.requestId,
          createdBy: entry.createdBy,
          reversalOfEntryId: entry.reversalOfEntryId,
          date: entry.date || new Date(),
        },
      });

      // Actualizar balance
      const account = await tx.account.findUnique({ where: { id: accountId } });
      if (!account) throw new AppError('Account not found', 404);

      const newBalance = account.balance.plus(new Prisma.Decimal(entry.valueSigned));
      await tx.account.update({
        where: { id: accountId },
        data: { balance: newBalance },
      });

      return ledgerEntry;
    });
  }

  /**
   * Obtener entrada ledger por ID
   */
  static async getLedgerEntryById(entryId: string): Promise<LedgerEntry | null> {
    return prisma.ledgerEntry.findUnique({
      where: { id: entryId },
    });
  }

  /**
   * Listar entradas ledger con filtros
   */
  static async listLedgerEntries(filters: {
    accountId: string;
    type?: LedgerType[];
    from?: Date;
    to?: Date;
    referenceType?: ReferenceType;
    page?: number;
    pageSize?: number;
    sort?: 'date' | 'createdAt';
    order?: 'asc' | 'desc';
  }) {
    const { accountId, type, from, to, referenceType, page = 1, pageSize = 20, sort = 'date', order = 'desc' } = filters;

    const where: Prisma.LedgerEntryWhereInput = { accountId };
    if (type && type.length > 0) where.type = { in: type };
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = from;
      if (to) where.date.lte = to;
    }
    if (referenceType) where.referenceType = referenceType;

    const orderBy: Prisma.LedgerEntryOrderByWithRelationInput = {};
    orderBy[sort] = order;

    const total = await prisma.ledgerEntry.count({ where });
    const items = await prisma.ledgerEntry.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    return {
      items,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * Calcular balance (suma de entradas)
   */
  static async calculateBalance(accountId: string): Promise<Prisma.Decimal> {
    const result = await prisma.ledgerEntry.aggregate({
      where: { accountId },
      _sum: { valueSigned: true },
    });

    return result._sum.valueSigned || new Prisma.Decimal(0);
  }

  /**
   * Obtener resumen de balance
   */
  static async getBalanceSummary(accountId: string) {
    const [totalDebit, totalCredit, entryCount] = await Promise.all([
      prisma.ledgerEntry.aggregate({
        where: { accountId, valueSigned: { lt: new Prisma.Decimal(0) } },
        _sum: { valueSigned: true },
      }),
      prisma.ledgerEntry.aggregate({
        where: { accountId, valueSigned: { gt: new Prisma.Decimal(0) } },
        _sum: { valueSigned: true },
      }),
      prisma.ledgerEntry.count({ where: { accountId } }),
    ]);

    return {
      balance: (totalCredit._sum.valueSigned || new Prisma.Decimal(0)).plus(
        totalDebit._sum.valueSigned || new Prisma.Decimal(0)
      ),
      totalDebit: totalDebit._sum.valueSigned || new Prisma.Decimal(0),
      totalCredit: totalCredit._sum.valueSigned || new Prisma.Decimal(0),
      entryCount,
    };
  }

  /**
   * Crear depósito bancario con entrada ledger
   */
  static async createBankDeposit(
    accountId: string,
    depositData: {
      date: Date;
      docNumber: string;
      amount: Prisma.Decimal | number;
      bankName?: string;
      note?: string;
      receiptUrl?: string;
      createdBy: string;
      requestId?: string;
    }
  ) {
    const depositAmount = new Prisma.Decimal(depositData.amount);

    return prisma.$transaction(async (tx) => {
      const deposit = await tx.bankDeposit.create({
        data: {
          accountId,
          date: depositData.date,
          docNumber: depositData.docNumber,
          amount: depositAmount,
          bankName: depositData.bankName,
          note: depositData.note,
          receiptUrl: depositData.receiptUrl,
          createdBy: depositData.createdBy,
        },
      });

      const ledgerEntry = await tx.ledgerEntry.create({
        data: {
          accountId,
          type: LedgerType.DEPOSIT,
          valueSigned: depositAmount.negated(),
          referenceType: ReferenceType.DEPOSIT_RECEIPT,
          referenceId: deposit.id,
          note: `Bank deposit: ${depositData.docNumber}`,
          requestId: depositData.requestId,
          createdBy: depositData.createdBy,
          date: depositData.date,
        },
      });

      const account = await tx.account.findUnique({ where: { id: accountId } });
      if (!account) throw new AppError('Account not found', 404);

      const newBalance = account.balance.minus(depositAmount);
      await tx.account.update({
        where: { id: accountId },
        data: { balance: newBalance },
      });

      return { deposit, ledgerEntry };
    });
  }

  /**
   * Obtener depósito bancario por ID
   */
  static async getBankDepositById(depositId: string): Promise<BankDeposit | null> {
    return prisma.bankDeposit.findUnique({
      where: { id: depositId },
    });
  }

  /**
   * Listar depósitos bancarios
   */
  static async listBankDeposits(filters: {
    accountId?: string;
    from?: Date;
    to?: Date;
    page?: number;
    pageSize?: number;
  }) {
    const { accountId, from, to, page = 1, pageSize = 20 } = filters;

    const where: Prisma.BankDepositWhereInput = {};
    if (accountId) where.accountId = accountId;
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = from;
      if (to) where.date.lte = to;
    }

    const total = await prisma.bankDeposit.count({ where });
    const items = await prisma.bankDeposit.findMany({
      where,
      orderBy: { date: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    return {
      items,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * Crear snapshot diario
   */
  static async createDailySnapshot(
    accountId: string,
    date: Date,
    snapshot: {
      opening: Prisma.Decimal;
      debit: Prisma.Decimal;
      credit: Prisma.Decimal;
      closing: Prisma.Decimal;
    }
  ) {
    return prisma.dailyBalanceSnapshot.upsert({
      where: { accountId_date: { accountId, date: new Date(date.toDateString()) } },
      update: snapshot,
      create: {
        accountId,
        date: new Date(date.toDateString()),
        ...snapshot,
      },
    });
  }

  /**
   * Obtener snapshots diarios para rango de fechas
   */
  static async getDailySnapshots(accountId: string, from: Date, to: Date) {
    return prisma.dailyBalanceSnapshot.findMany({
      where: {
        accountId,
        date: { gte: from, lte: to },
      },
      orderBy: { date: 'asc' },
    });
  }

  /**
   * Encontrar entrada por requestId (idempotencia)
   */
  static async findEntryByRequestId(
    accountId: string,
    requestId: string
  ): Promise<LedgerEntry | null> {
    return prisma.ledgerEntry.findFirst({
      where: { accountId, requestId },
    });
  }
}

export default AccountsRepository;
