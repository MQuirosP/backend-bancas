import prisma from '../../../core/prismaClient';
import { OwnerType, LedgerType, ReferenceType, Prisma, ActivityType, LedgerEntry } from '@prisma/client';
import { AppError } from '../../../core/errors';
import ActivityService from '../../../core/activity.service';
import AccountsRepository from '../modules/accounts/accounts.repository';
import logger from '../../../core/logger';

export class AccountsService {
  /**
   * Obtener o crear cuenta para propietario
   */
  static async getOrCreateAccount(
    ownerType: OwnerType,
    ownerId: string,
    currency: string = 'CRC'
  ) {
    return AccountsRepository.getOrCreateAccount(ownerType, ownerId, currency);
  }

  /**
   * Obtener detalles de cuenta
   */
  static async getAccountDetails(accountId: string) {
    const account = await AccountsRepository.getAccountWithMetadata(accountId);
    if (!account) {
      throw new AppError('Account not found', 404);
    }
    const balance = parseFloat(account.balance.toString());
    return {
      id: account.id,
      ownerType: account.ownerType,
      ownerId: account.ownerId,
      currency: account.currency,
      balance,
      isActive: account.isActive,
      entryCount: (account as any).entryCount,
      latestEntry: (account as any).latestEntry,
      createdAt: account.createdAt,
    };
  }

  /**
   * Obtener balance actual de cuenta con estado CXC/CXP
   */
  static async getBalance(accountId: string) {
    const account = await AccountsRepository.getAccountById(accountId);
    if (!account) {
      throw new AppError('Account not found', 404);
    }

    const balance = parseFloat(account.balance.toString());
    const debtStatus = balance > 0 ? 'CXC' : balance < 0 ? 'CXP' : 'BALANCE';

    return {
      accountId: account.id,
      balance,
      currency: account.currency,
      debtStatus: {
        status: debtStatus,
        amount: Math.abs(balance),
        description:
          debtStatus === 'CXC'
            ? `Cuentas por Cobrar (nos deben ${Math.abs(balance)})`
            : debtStatus === 'CXP'
              ? `Cuentas por Pagar (debemos ${Math.abs(balance)})`
              : 'Balance cuadrado',
      },
      asOf: new Date(),
    };
  }

  /**
   * Registrar entrada de venta
   */
  static async addSaleEntry(
    accountId: string,
    saleData: {
      ticketId: string;
      amount: number | Prisma.Decimal;
      requestId?: string;
      createdBy: string;
    }
  ) {
    const amount = new Prisma.Decimal(saleData.amount);

    // Verificar idempotencia
    if (saleData.requestId) {
      const existing = await AccountsRepository.findEntryByRequestId(accountId, saleData.requestId);
      if (existing) {
        return existing;
      }
    }

    try {
      const entry = await AccountsRepository.addLedgerEntry(accountId, {
        type: LedgerType.SALE,
        valueSigned: amount,
        referenceType: ReferenceType.TICKET,
        referenceId: saleData.ticketId,
        note: `Sale from ticket ${saleData.ticketId}`,
        requestId: saleData.requestId,
        createdBy: saleData.createdBy,
      });

      // Registrar en activity log
      await ActivityService.log({
        userId: saleData.createdBy,
        action: ActivityType.LEDGER_ADD,
        targetType: 'LEDGER_ENTRY',
        targetId: entry.id,
        details: {
          accountId,
          type: 'SALE',
          amount: amount.toString(),
          ticketId: saleData.ticketId,
        },
        requestId: saleData.requestId,
        layer: 'service',
      });

      return {
        entryId: entry.id,
        type: entry.type,
        amount: parseFloat(amount.toString()),
        referenceId: entry.referenceId,
        createdAt: entry.createdAt,
      };
    } catch (error) {
      logger.error({
        layer: 'service',
        action: 'SALE_ENTRY_FAIL',
        payload: {
          accountId,
          ticketId: saleData.ticketId,
          error: error instanceof Error ? error.message : 'Unknown',
        },
      });
      throw new AppError('Failed to add sale entry', 500);
    }
  }

  /**
   * Registrar entrada de comisión
   */
  static async addCommissionEntry(
    accountId: string,
    commissionData: {
      saleAmount: number | Prisma.Decimal;
      commissionRate: number;
      ticketId: string;
      requestId?: string;
      createdBy: string;
    }
  ) {
    const saleAmount = new Prisma.Decimal(commissionData.saleAmount);
    const commissionAmount = saleAmount.times(new Prisma.Decimal(commissionData.commissionRate));

    if (commissionData.requestId) {
      const existing = await AccountsRepository.findEntryByRequestId(accountId, commissionData.requestId);
      if (existing) {
        return existing;
      }
    }

    try {
      const entry = await AccountsRepository.addLedgerEntry(accountId, {
        type: LedgerType.COMMISSION,
        valueSigned: commissionAmount,
        referenceType: ReferenceType.TICKET,
        referenceId: commissionData.ticketId,
        note: `Commission (${(commissionData.commissionRate * 100).toFixed(2)}%) on ticket ${commissionData.ticketId}`,
        requestId: commissionData.requestId,
        createdBy: commissionData.createdBy,
      });

      await ActivityService.log({
        userId: commissionData.createdBy,
        action: ActivityType.LEDGER_ADD,
        targetType: 'LEDGER_ENTRY',
        targetId: entry.id,
        details: {
          accountId,
          type: 'COMMISSION',
          commissionAmount: commissionAmount.toString(),
          ticketId: commissionData.ticketId,
        },
        requestId: commissionData.requestId,
        layer: 'service',
      });

      return {
        entryId: entry.id,
        type: entry.type,
        amount: parseFloat(commissionAmount.toString()),
        referenceId: entry.referenceId,
        createdAt: entry.createdAt,
      };
    } catch (error) {
      logger.error({
        layer: 'service',
        action: 'COMMISSION_ENTRY_FAIL',
        payload: {
          accountId,
          ticketId: commissionData.ticketId,
          error: error instanceof Error ? error.message : 'Unknown',
        },
      });
      throw new AppError('Failed to add commission entry', 500);
    }
  }

  /**
   * Registrar entrada de pago
   */
  static async addPayoutEntry(
    accountId: string,
    payoutData: {
      amount: number | Prisma.Decimal;
      payoutId: string;
      reason?: string;
      requestId?: string;
      createdBy: string;
    }
  ) {
    const amount = new Prisma.Decimal(payoutData.amount).negated();

    if (payoutData.requestId) {
      const existing = await AccountsRepository.findEntryByRequestId(accountId, payoutData.requestId);
      if (existing) {
        return existing;
      }
    }

    try {
      const entry = await AccountsRepository.addLedgerEntry(accountId, {
        type: LedgerType.PAYOUT,
        valueSigned: amount,
        referenceType: ReferenceType.PAYOUT_RECEIPT,
        referenceId: payoutData.payoutId,
        note: payoutData.reason || `Payout ${payoutData.payoutId}`,
        requestId: payoutData.requestId,
        createdBy: payoutData.createdBy,
      });

      await ActivityService.log({
        userId: payoutData.createdBy,
        action: ActivityType.LEDGER_ADD,
        targetType: 'LEDGER_ENTRY',
        targetId: entry.id,
        details: {
          accountId,
          type: 'PAYOUT',
          amount: amount.toString(),
          payoutId: payoutData.payoutId,
        },
        requestId: payoutData.requestId,
        layer: 'service',
      });

      return {
        entryId: entry.id,
        type: entry.type,
        amount: parseFloat(amount.toString()),
        referenceId: entry.referenceId,
        createdAt: entry.createdAt,
      };
    } catch (error) {
      logger.error({
        layer: 'service',
        action: 'PAYOUT_ENTRY_FAIL',
        payload: {
          accountId,
          payoutId: payoutData.payoutId,
          error: error instanceof Error ? error.message : 'Unknown',
        },
      });
      throw new AppError('Failed to add payout entry', 500);
    }
  }

  /**
   * Crear depósito bancario
   */
  static async createBankDeposit(
    accountId: string,
    depositData: {
      date: Date;
      docNumber: string;
      amount: number | Prisma.Decimal;
      bankName?: string;
      note?: string;
      receiptUrl?: string;
      requestId?: string;
      createdBy: string;
    }
  ) {
    if (depositData.requestId) {
      const existing = await AccountsRepository.findEntryByRequestId(accountId, depositData.requestId);
      if (existing) {
        return existing;
      }
    }

    try {
      const result = await AccountsRepository.createBankDeposit(accountId, {
        date: depositData.date,
        docNumber: depositData.docNumber,
        amount: new Prisma.Decimal(depositData.amount),
        bankName: depositData.bankName,
        note: depositData.note,
        receiptUrl: depositData.receiptUrl,
        createdBy: depositData.createdBy,
        requestId: depositData.requestId,
      });

      await ActivityService.log({
        userId: depositData.createdBy,
        action: ActivityType.DEPOSIT_CREATE,
        targetType: 'BANK_DEPOSIT',
        targetId: result.deposit.id,
        details: {
          accountId,
          docNumber: depositData.docNumber,
          amount: new Prisma.Decimal(depositData.amount).toString(),
          bankName: depositData.bankName,
        },
        requestId: depositData.requestId,
        layer: 'service',
      });

      return {
        depositId: result.deposit.id,
        docNumber: result.deposit.docNumber,
        amount: parseFloat(result.deposit.amount.toString()),
        date: result.deposit.date,
        bankName: result.deposit.bankName,
        entryId: result.ledgerEntry.id,
        createdAt: result.deposit.createdAt,
      };
    } catch (error) {
      logger.error({
        layer: 'service',
        action: 'DEPOSIT_CREATE_FAIL',
        payload: {
          accountId,
          docNumber: depositData.docNumber,
          error: error instanceof Error ? error.message : 'Unknown',
        },
      });
      throw new AppError('Failed to create bank deposit', 500);
    }
  }

  /**
   * Reversar entrada ledger
   */
  static async reverseEntry(
    accountId: string,
    entryId: string,
    reversalData: {
      reason: string;
      requestId?: string;
      createdBy: string;
    }
  ) {
    if (reversalData.requestId) {
      const existing = await AccountsRepository.findEntryByRequestId(accountId, reversalData.requestId);
      if (existing) {
        return existing;
      }
    }

    try {
      const originalEntry = await AccountsRepository.getLedgerEntryById(entryId);
      if (!originalEntry) {
        throw new AppError('Entry not found', 404);
      }

      if (originalEntry.accountId !== accountId) {
        throw new AppError('Entry does not belong to account', 400);
      }

      const reversalAmount = originalEntry.valueSigned.negated();
      const reversalEntry = await AccountsRepository.addLedgerEntry(accountId, {
        type: LedgerType.REVERSAL,
        valueSigned: reversalAmount,
        referenceType: originalEntry.referenceType || undefined,
        referenceId: originalEntry.referenceId || undefined,
        note: `Reversal: ${reversalData.reason}`,
        requestId: reversalData.requestId,
        createdBy: reversalData.createdBy,
        reversalOfEntryId: entryId,
      });

      await ActivityService.log({
        userId: reversalData.createdBy,
        action: ActivityType.LEDGER_REVERSE,
        targetType: 'LEDGER_ENTRY',
        targetId: reversalEntry.id,
        details: {
          accountId,
          originalEntryId: entryId,
          reversalAmount: reversalAmount.toString(),
          reason: reversalData.reason,
        },
        requestId: reversalData.requestId,
        layer: 'service',
      });

      return {
        reversalId: reversalEntry.id,
        originalEntryId: entryId,
        reversalAmount: parseFloat(reversalAmount.toString()),
        reason: reversalData.reason,
        createdAt: reversalEntry.createdAt,
      };
    } catch (error) {
      logger.error({
        layer: 'service',
        action: 'LEDGER_REVERSE_FAIL',
        payload: {
          accountId,
          entryId,
          error: error instanceof Error ? error.message : 'Unknown',
        },
      });
      if (error instanceof AppError) throw error;
      throw new AppError('Failed to reverse entry', 500);
    }
  }

  /**
   * Listar entradas ledger con filtros
   */
  static async listLedgerEntries(
    accountId: string,
    filters: {
      type?: string[];
      from?: Date;
      to?: Date;
      referenceType?: string;
      page?: number;
      pageSize?: number;
      sort?: 'date' | 'createdAt';
      order?: 'asc' | 'desc';
    } = {}
  ) {
    try {
      const typesArray = filters.type?.length ? (filters.type as LedgerType[]) : undefined;

      const result = await AccountsRepository.listLedgerEntries({
        accountId,
        type: typesArray,
        from: filters.from,
        to: filters.to,
        referenceType: filters.referenceType as ReferenceType | undefined,
        page: filters.page,
        pageSize: filters.pageSize,
        sort: filters.sort,
        order: filters.order,
      });

      return {
        entries: result.items.map(entry => ({
          id: entry.id,
          type: entry.type,
          amount: parseFloat(entry.valueSigned.toString()),
          referenceType: entry.referenceType,
          referenceId: entry.referenceId,
          note: entry.note,
          date: entry.date,
          createdAt: entry.createdAt,
          createdBy: entry.createdBy,
          reversalOfEntryId: entry.reversalOfEntryId,
        })),
        pagination: {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          totalPages: result.totalPages,
        },
      };
    } catch (error) {
      logger.error({
        layer: 'service',
        action: 'LIST_ENTRIES_FAIL',
        payload: { accountId, error: error instanceof Error ? error.message : 'Unknown' },
      });
      throw new AppError('Failed to list ledger entries', 500);
    }
  }

  /**
   * Obtener resumen de balance
   */
  static async getBalanceSummary(accountId: string) {
    try {
      const summary = await AccountsRepository.getBalanceSummary(accountId);

      return {
        accountId,
        balance: parseFloat(summary.balance.toString()),
        totalDebit: parseFloat(summary.totalDebit.toString()),
        totalCredit: parseFloat(summary.totalCredit.toString()),
        entryCount: summary.entryCount,
        asOf: new Date(),
      };
    } catch (error) {
      logger.error({
        layer: 'service',
        action: 'BALANCE_SUMMARY_FAIL',
        payload: { accountId, error: error instanceof Error ? error.message : 'Unknown' },
      });
      throw new AppError('Failed to get balance summary', 500);
    }
  }

  /**
   * Crear snapshot diario de balance
   */
  static async createDailySnapshot(
    accountId: string,
    date: Date,
    snapshotData: {
      opening: number | Prisma.Decimal;
      debit: number | Prisma.Decimal;
      credit: number | Prisma.Decimal;
      closing: number | Prisma.Decimal;
      createdBy: string;
    }
  ) {
    try {
      const snapshot = await AccountsRepository.createDailySnapshot(accountId, date, {
        opening: new Prisma.Decimal(snapshotData.opening),
        debit: new Prisma.Decimal(snapshotData.debit),
        credit: new Prisma.Decimal(snapshotData.credit),
        closing: new Prisma.Decimal(snapshotData.closing),
      });

      await ActivityService.log({
        userId: snapshotData.createdBy,
        action: ActivityType.SNAPSHOT_CREATE,
        targetType: 'DAILY_SNAPSHOT',
        targetId: snapshot.id,
        details: { accountId, date: date.toISOString() },
        layer: 'service',
      });

      return {
        snapshotId: snapshot.id,
        date: snapshot.date,
        opening: parseFloat(snapshot.opening.toString()),
        debit: parseFloat(snapshot.debit.toString()),
        credit: parseFloat(snapshot.credit.toString()),
        closing: parseFloat(snapshot.closing.toString()),
        createdAt: snapshot.createdAt,
      };
    } catch (error) {
      logger.error({
        layer: 'service',
        action: 'SNAPSHOT_CREATE_FAIL',
        payload: { accountId, error: error instanceof Error ? error.message : 'Unknown' },
      });
      throw new AppError('Failed to create daily snapshot', 500);
    }
  }

  /**
   * Obtener snapshots diarios para rango de fechas
   */
  static async getDailySnapshots(accountId: string, from: Date, to: Date) {
    try {
      const snapshots = await AccountsRepository.getDailySnapshots(accountId, from, to);

      return snapshots.map(s => ({
        snapshotId: s.id,
        date: s.date,
        opening: parseFloat(s.opening.toString()),
        debit: parseFloat(s.debit.toString()),
        credit: parseFloat(s.credit.toString()),
        closing: parseFloat(s.closing.toString()),
        createdAt: s.createdAt,
      }));
    } catch (error) {
      logger.error({
        layer: 'service',
        action: 'GET_SNAPSHOTS_FAIL',
        payload: { accountId, error: error instanceof Error ? error.message : 'Unknown' },
      });
      throw new AppError('Failed to get daily snapshots', 500);
    }
  }

  /**
   * Exportar estado de cuenta
   */
  static async exportStatement(
    accountId: string,
    from: Date,
    to: Date,
    exportedBy: string
  ) {
    try {
      const account = await AccountsRepository.getAccountById(accountId);
      if (!account) {
        throw new AppError('Account not found', 404);
      }

      const entries = await AccountsRepository.listLedgerEntries({
        accountId,
        from,
        to,
        pageSize: 10000,
      });

      const snapshots = await AccountsRepository.getDailySnapshots(accountId, from, to);

      await ActivityService.log({
        userId: exportedBy,
        action: ActivityType.STATEMENT_EXPORT,
        targetType: 'STATEMENT',
        targetId: accountId,
        details: {
          from: from.toISOString(),
          to: to.toISOString(),
          entryCount: entries.total,
        },
        layer: 'service',
      });

      return {
        accountId,
        ownerType: account.ownerType,
        ownerId: account.ownerId,
        currency: account.currency,
        period: { from, to },
        entries: entries.items.map(e => ({
          id: e.id,
          type: e.type,
          amount: parseFloat(e.valueSigned.toString()),
          referenceType: e.referenceType,
          referenceId: e.referenceId,
          note: e.note,
          date: e.date,
          createdAt: e.createdAt,
        })),
        snapshots: snapshots.map(s => ({
          date: s.date,
          opening: parseFloat(s.opening.toString()),
          debit: parseFloat(s.debit.toString()),
          credit: parseFloat(s.credit.toString()),
          closing: parseFloat(s.closing.toString()),
        })),
        totalEntries: entries.total,
        totalSnapshots: snapshots.length,
        generatedAt: new Date(),
      };
    } catch (error) {
      logger.error({
        layer: 'service',
        action: 'STATEMENT_EXPORT_FAIL',
        payload: { accountId, error: error instanceof Error ? error.message : 'Unknown' },
      });
      if (error instanceof AppError) throw error;
      throw new AppError('Failed to export statement', 500);
    }
  }

  /**
   * Listar cuentas
   */
  static async listAccounts(filters: {
    ownerType?: string;
    ownerId?: string;
    isActive?: boolean;
    page?: number;
    pageSize?: number;
  } = {}) {
    try {
      const result = await AccountsRepository.listAccounts({
        ownerType: filters.ownerType as OwnerType | undefined,
        ownerId: filters.ownerId,
        isActive: filters.isActive,
        page: filters.page,
        pageSize: filters.pageSize,
      });

      return {
        accounts: result.items.map(account => ({
          id: account.id,
          ownerType: account.ownerType,
          ownerId: account.ownerId,
          currency: account.currency,
          balance: parseFloat(account.balance.toString()),
          isActive: account.isActive,
          createdAt: account.createdAt,
        })),
        pagination: {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          totalPages: result.totalPages,
        },
      };
    } catch (error) {
      logger.error({
        layer: 'service',
        action: 'LIST_ACCOUNTS_FAIL',
        payload: { error: error instanceof Error ? error.message : 'Unknown' },
      });
      throw new AppError('Failed to list accounts', 500);
    }
  }

  /**
   * Obtener ledger diario totalizado con estado CXC/CXP
   * CXC = Cuentas por Cobrar (balance positivo = nos deben)
   * CXP = Cuentas por Pagar (balance negativo = debemos)
   */
  static async getDailyLedgerSummary(
    accountId: string,
    filters: { from?: Date; to?: Date } = {}
  ) {
    try {
      const account = await AccountsRepository.getAccountById(accountId);
      if (!account) {
        throw new AppError('Account not found', 404);
      }

      // Obtener snapshots diarios
      const from = filters.from || new Date(new Date().getFullYear(), 0, 1);
      const to = filters.to || new Date();

      const snapshots = await AccountsRepository.getDailySnapshots(accountId, from, to);

      // Obtener todas las entradas del período para detalles
      const entries = await prisma.ledgerEntry.findMany({
        where: {
          accountId,
          date: { gte: from, lte: to },
        },
        orderBy: { date: 'asc' },
      });

      // Agrupar entradas por día
      const entriesByDate: Record<string, LedgerEntry[]> = {};
      entries.forEach(entry => {
        const dateStr = entry.date.toISOString().split('T')[0];
        if (!entriesByDate[dateStr]) {
          entriesByDate[dateStr] = [];
        }
        entriesByDate[dateStr].push(entry);
      });

      // Determinar estado actual
      const currentBalance = parseFloat(account.balance.toString());
      const debtStatus = currentBalance > 0 ? 'CXC' : currentBalance < 0 ? 'CXP' : 'BALANCE';
      const debtAmount = Math.abs(currentBalance);

      return {
        account: {
          id: account.id,
          ownerType: account.ownerType,
          ownerId: account.ownerId,
          currency: account.currency,
        },
        debtStatus: {
          status: debtStatus,
          amount: debtAmount,
          description:
            debtStatus === 'CXC'
              ? `Cuentas por Cobrar (nos deben ${debtAmount})`
              : debtStatus === 'CXP'
                ? `Cuentas por Pagar (debemos ${debtAmount})`
                : 'Balance cuadrado',
        },
        dailySummary: snapshots.map(snapshot => ({
          date: snapshot.date.toISOString().split('T')[0],
          opening: parseFloat(snapshot.opening.toString()),
          debit: parseFloat(snapshot.debit.toString()),
          credit: parseFloat(snapshot.credit.toString()),
          closing: parseFloat(snapshot.closing.toString()),
          entries: (entriesByDate[snapshot.date.toISOString().split('T')[0]] || []).map(e => ({
            id: e.id,
            type: e.type,
            amount: parseFloat(e.valueSigned.toString()),
            referenceType: e.referenceType,
            referenceId: e.referenceId,
            note: e.note,
          })),
        })),
        summary: {
          totalDebit: snapshots.reduce(
            (sum, s) => sum + parseFloat(s.debit.toString()),
            0
          ),
          totalCredit: snapshots.reduce(
            (sum, s) => sum + parseFloat(s.credit.toString()),
            0
          ),
          currentBalance: currentBalance,
        },
      };
    } catch (error) {
      logger.error({
        layer: 'service',
        action: 'DAILY_LEDGER_SUMMARY_FAIL',
        payload: { accountId, error: error instanceof Error ? error.message : 'Unknown' },
      });
      if (error instanceof AppError) throw error;
      throw new AppError('Failed to get daily ledger summary', 500);
    }
  }

  /**
   * Registrar documento de pago entre cuentas
   * Crea entradas TRANSFER en ambas cuentas y reduce la deuda
   */
  static async createPaymentDocument(
    paymentData: {
      fromAccountId: string;
      toAccountId: string;
      amount: number | Prisma.Decimal;
      docNumber: string;
      date: Date;
      description?: string;
      receiptUrl?: string;
      requestId?: string;
      createdBy: string;
    }
  ) {
    const amount = new Prisma.Decimal(paymentData.amount);

    // Verificar idempotencia
    if (paymentData.requestId) {
      const existing = await prisma.paymentDocument.findFirst({
        where: { requestId: paymentData.requestId },
      });
      if (existing) {
        return existing;
      }
    }

    try {
      // Crear documento de pago y entradas ledger en una transacción
      const result = await prisma.$transaction(async tx => {
        // Crear documento de pago
        const paymentDoc = await tx.paymentDocument.create({
          data: {
            fromAccountId: paymentData.fromAccountId,
            toAccountId: paymentData.toAccountId,
            amount,
            docNumber: paymentData.docNumber,
            date: paymentData.date,
            description: paymentData.description,
            receiptUrl: paymentData.receiptUrl,
            requestId: paymentData.requestId,
            createdBy: paymentData.createdBy,
          },
        });

        // Crear entrada TRANSFER en cuenta origen (salida = negativo)
        const fromEntry = await tx.ledgerEntry.create({
          data: {
            accountId: paymentData.fromAccountId,
            type: LedgerType.TRANSFER,
            valueSigned: amount.negated(),
            referenceType: ReferenceType.OTHER,
            referenceId: paymentDoc.id,
            note: `Payment document ${paymentDoc.docNumber} to account`,
            createdBy: paymentData.createdBy,
            date: paymentData.date,
          },
        });

        // Crear entrada TRANSFER en cuenta destino (entrada = positivo)
        const toEntry = await tx.ledgerEntry.create({
          data: {
            accountId: paymentData.toAccountId,
            type: LedgerType.TRANSFER,
            valueSigned: amount,
            referenceType: ReferenceType.OTHER,
            referenceId: paymentDoc.id,
            note: `Payment document ${paymentDoc.docNumber} from account`,
            createdBy: paymentData.createdBy,
            date: paymentData.date,
          },
        });

        // Actualizar balances de ambas cuentas
        await tx.account.update({
          where: { id: paymentData.fromAccountId },
          data: { balance: { decrement: amount } },
        });

        await tx.account.update({
          where: { id: paymentData.toAccountId },
          data: { balance: { increment: amount } },
        });

        return { paymentDoc, fromEntry, toEntry };
      });

      // Registrar en activity log
      await ActivityService.log({
        userId: paymentData.createdBy,
        action: ActivityType.LEDGER_ADD,
        targetType: 'PAYMENT_DOCUMENT',
        targetId: result.paymentDoc.id,
        details: {
          fromAccountId: paymentData.fromAccountId,
          toAccountId: paymentData.toAccountId,
          amount: amount.toString(),
          docNumber: paymentData.docNumber,
        },
        requestId: paymentData.requestId,
        layer: 'service',
      });

      return {
        paymentDocumentId: result.paymentDoc.id,
        fromAccountId: result.paymentDoc.fromAccountId,
        toAccountId: result.paymentDoc.toAccountId,
        amount: parseFloat(amount.toString()),
        docNumber: result.paymentDoc.docNumber,
        date: result.paymentDoc.date,
        createdAt: result.paymentDoc.createdAt,
      };
    } catch (error) {
      logger.error({
        layer: 'service',
        action: 'PAYMENT_DOCUMENT_CREATE_FAIL',
        payload: {
          fromAccountId: paymentData.fromAccountId,
          toAccountId: paymentData.toAccountId,
          amount: amount.toString(),
          error: error instanceof Error ? error.message : 'Unknown',
        },
      });
      throw new AppError('Failed to create payment document', 500);
    }
  }

  /**
   * Actualizar cuenta
   */
  static async updateAccount(
    accountId: string,
    data: { isActive?: boolean },
    updatedBy: string
  ) {
    try {
      const updated = await AccountsRepository.updateAccount(accountId, {
        isActive: data.isActive,
      });

      if (data.isActive !== undefined) {
        await ActivityService.log({
          userId: updatedBy,
          action: ActivityType.ACCOUNT_UPDATE,
          targetType: 'ACCOUNT',
          targetId: accountId,
          details: { isActive: data.isActive },
          layer: 'service',
        });
      }

      return {
        id: updated.id,
        ownerType: updated.ownerType,
        ownerId: updated.ownerId,
        currency: updated.currency,
        balance: parseFloat(updated.balance.toString()),
        isActive: updated.isActive,
        createdAt: updated.createdAt,
      };
    } catch (error) {
      logger.error({
        layer: 'service',
        action: 'ACCOUNT_UPDATE_FAIL',
        payload: { accountId, error: error instanceof Error ? error.message : 'Unknown' },
      });
      throw new AppError('Failed to update account', 500);
    }
  }
}

export default AccountsService;
