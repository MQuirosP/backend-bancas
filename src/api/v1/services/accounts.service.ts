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
   * Crear cuenta con saldo inicial opcional
   * Si se proporciona initialBalance, crea una entrada ADJUSTMENT para documentar el saldo de apertura
   */
  static async createAccount(
    data: {
      ownerType: OwnerType;
      ownerId: string;
      currency?: string;
      initialBalance?: number | Prisma.Decimal;
      initialBalanceNote?: string;
      createdBy: string;
    }
  ) {
    try {
      // Crear cuenta usando getOrCreateAccount (verifica si ya existe)
      const account = await AccountsRepository.getOrCreateAccount(
        data.ownerType,
        data.ownerId,
        data.currency || 'CRC'
      );

      // Si se proporciona saldo inicial, crear entrada ADJUSTMENT
      if (data.initialBalance !== undefined && data.initialBalance !== null) {
        const initialBalanceAmount = new Prisma.Decimal(data.initialBalance);

        // Crear entrada de ajuste para el saldo de apertura
        await AccountsRepository.addLedgerEntry(account.id, {
          type: LedgerType.ADJUSTMENT,
          valueSigned: initialBalanceAmount,
          referenceType: ReferenceType.ADJUSTMENT_DOC,
          referenceId: account.id,
          note:
            data.initialBalanceNote ||
            `Opening balance: ${initialBalanceAmount} (carried from previous day)`,
          createdBy: data.createdBy,
        });

        // Registrar en activity log
        await ActivityService.log({
          userId: data.createdBy,
          action: ActivityType.ACCOUNT_CREATE,
          targetType: 'ACCOUNT',
          targetId: account.id,
          details: {
            ownerType: data.ownerType,
            ownerId: data.ownerId,
            currency: data.currency || 'CRC',
            initialBalance: initialBalanceAmount.toString(),
          },
          layer: 'service',
        });
      }

      // Obtener cuenta actualizada con balance
      const updatedAccount = await AccountsRepository.getAccountWithMetadata(account.id);
      if (!updatedAccount) {
        throw new AppError('Failed to create account', 500);
      }

      const balance = parseFloat(updatedAccount.balance.toString());

      return {
        id: updatedAccount.id,
        ownerType: updatedAccount.ownerType,
        ownerId: updatedAccount.ownerId,
        currency: updatedAccount.currency,
        balance,
        isActive: updatedAccount.isActive,
        createdAt: updatedAccount.createdAt,
      };
    } catch (error) {
      logger.error({
        layer: 'service',
        action: 'CREATE_ACCOUNT_FAIL',
        payload: {
          ownerType: data.ownerType,
          ownerId: data.ownerId,
          error: error instanceof Error ? error.message : 'Unknown',
        },
      });
      if (error instanceof AppError) throw error;
      throw new AppError('Failed to create account', 500);
    }
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
   * Cierre diario: calcula saldo final del día actual y prepara apertura del siguiente
   * Proceso:
   * 1. Calcula saldo diario (debit/credit) desde todas las entradas del día
   * 2. Crea snapshot con opening, debit, credit, closing
   * 3. Crea ADJUSTMENT entry para el siguiente día con el saldo final (cierre del día anterior = apertura del siguiente)
   */
  static async closeDay(
    accountId: string,
    closeData: {
      date: Date; // Fecha del cierre (ej: 02/11/2025)
      createdBy: string;
    }
  ) {
    try {
      const account = await AccountsRepository.getAccountById(accountId);
      if (!account) {
        throw new AppError('Account not found', 404);
      }

      // Normalizar fecha al inicio del día (00:00:00)
      const closeDate = new Date(closeData.date);
      closeDate.setHours(0, 0, 0, 0);

      // Obtener todas las entradas del día actual (excluyendo ADJUSTMENT de apertura)
      const dayEntries = await prisma.ledgerEntry.findMany({
        where: {
          accountId,
          date: closeDate,
          type: { not: LedgerType.ADJUSTMENT }, // Excluir la entrada de apertura
        },
      });

      // Calcular totales del día
      let debit = new Prisma.Decimal(0);
      let credit = new Prisma.Decimal(0);

      dayEntries.forEach(entry => {
        if (entry.valueSigned.isNegative()) {
          debit = debit.minus(entry.valueSigned); // Resta = debit positivo
        } else {
          credit = credit.plus(entry.valueSigned); // Suma = credit positivo
        }
      });

      // Obtener balance actual (es el cierre del día)
      const currentBalance = account.balance;
      const closingBalance = currentBalance;

      // Opening = cierre del día anterior
      // Para obtener el opening, necesitamos el balance ANTES de las entradas de hoy
      const openingBalance = closingBalance.minus(credit).plus(debit);

      // Crear snapshot del día
      const snapshot = await AccountsRepository.createDailySnapshot(accountId, closeDate, {
        opening: openingBalance,
        debit,
        credit,
        closing: closingBalance,
      });

      // Si el cierre tiene un saldo != 0, crear ADJUSTMENT para el siguiente día
      if (!closingBalance.isZero()) {
        const nextDay = new Date(closeDate);
        nextDay.setDate(nextDay.getDate() + 1);

        // Crear ADJUSTMENT entry para el siguiente día con el saldo final
        await AccountsRepository.addLedgerEntry(accountId, {
          type: LedgerType.ADJUSTMENT,
          valueSigned: closingBalance,
          referenceType: ReferenceType.ADJUSTMENT_DOC,
          referenceId: snapshot.id,
          note: `Opening balance from ${closeDate.toISOString().split('T')[0]}: ${closingBalance.toString()} (${closingBalance.isPositive() ? 'CXC' : 'CXP'})`,
          date: nextDay,
          createdBy: closeData.createdBy,
        });
      }

      // Registrar en activity log
      await ActivityService.log({
        userId: closeData.createdBy,
        action: ActivityType.SNAPSHOT_CREATE,
        targetType: 'DAILY_CLOSE',
        targetId: snapshot.id,
        details: {
          accountId,
          date: closeDate.toISOString().split('T')[0],
          opening: openingBalance.toString(),
          debit: debit.toString(),
          credit: credit.toString(),
          closing: closingBalance.toString(),
        },
        layer: 'service',
      });

      return {
        snapshotId: snapshot.id,
        date: closeDate.toISOString().split('T')[0],
        opening: parseFloat(openingBalance.toString()),
        debit: parseFloat(debit.toString()),
        credit: parseFloat(credit.toString()),
        closing: parseFloat(closingBalance.toString()),
        debtStatus: {
          status: closingBalance.isPositive() ? 'CXC' : closingBalance.isNegative() ? 'CXP' : 'BALANCE',
          amount: Math.abs(parseFloat(closingBalance.toString())),
        },
        message:
          !closingBalance.isZero()
            ? `Closing recorded. Opening balance of ${closingBalance.toString()} (${closingBalance.isPositive() ? 'CXC' : 'CXP'}) prepared for next day.`
            : 'Closing recorded with zero balance.',
      };
    } catch (error) {
      logger.error({
        layer: 'service',
        action: 'DAILY_CLOSE_FAIL',
        payload: {
          accountId,
          date: closeData.date.toISOString(),
          error: error instanceof Error ? error.message : 'Unknown',
        },
      });
      if (error instanceof AppError) throw error;
      throw new AppError('Failed to close day', 500);
    }
  }

  /**
   * Obtener resumen diario de cuenta para una fecha específica
   * Retorna: opening, debit, credit, closing, y estado de deuda (CXC/CXP)
   */
  static async getDailySummary(accountId: string, date: Date) {
    try {
      const account = await AccountsRepository.getAccountById(accountId);
      if (!account) {
        throw new AppError('Account not found', 404);
      }

      // Normalizar fecha al inicio del día
      const queryDate = new Date(date);
      queryDate.setHours(0, 0, 0, 0);

      // Obtener snapshot si existe
      const snapshots = await AccountsRepository.getDailySnapshots(accountId, queryDate, queryDate);

      if (snapshots.length === 0) {
        // Si no hay snapshot, calcular desde entradas
        const dayEntries = await prisma.ledgerEntry.findMany({
          where: {
            accountId,
            date: queryDate,
          },
        });

        let debit = new Prisma.Decimal(0);
        let credit = new Prisma.Decimal(0);

        dayEntries.forEach(entry => {
          if (entry.valueSigned.isNegative()) {
            debit = debit.minus(entry.valueSigned);
          } else {
            credit = credit.plus(entry.valueSigned);
          }
        });

        // Si no hay movimientos, retornar estado actual
        if (dayEntries.length === 0) {
          const currentBalance = account.balance;
          return {
            date: queryDate.toISOString().split('T')[0],
            opening: 0,
            debit: 0,
            credit: 0,
            closing: parseFloat(currentBalance.toString()),
            debtStatus: currentBalance.isPositive()
              ? 'CXC'
              : currentBalance.isNegative()
                ? 'CXP'
                : 'BALANCE',
            debtAmount: Math.abs(parseFloat(currentBalance.toString())),
            description:
              currentBalance.isPositive()
                ? `Le debemos ${Math.abs(parseFloat(currentBalance.toString()))} al listero`
                : currentBalance.isNegative()
                  ? `El listero nos debe ${Math.abs(parseFloat(currentBalance.toString()))}`
                  : 'Balance cuadrado',
            entries: [],
          };
        }

        // Calcular opening como closing anterior
        const opening = account.balance.minus(credit).plus(debit);

        return {
          date: queryDate.toISOString().split('T')[0],
          opening: parseFloat(opening.toString()),
          debit: parseFloat(debit.toString()),
          credit: parseFloat(credit.toString()),
          closing: parseFloat(account.balance.toString()),
          debtStatus: account.balance.isPositive()
            ? 'CXC'
            : account.balance.isNegative()
              ? 'CXP'
              : 'BALANCE',
          debtAmount: Math.abs(parseFloat(account.balance.toString())),
          description:
            account.balance.isPositive()
              ? `Le debemos ${Math.abs(parseFloat(account.balance.toString()))} al listero`
              : account.balance.isNegative()
                ? `El listero nos debe ${Math.abs(parseFloat(account.balance.toString()))}`
                : 'Balance cuadrado',
          entries: dayEntries.length,
        };
      }

      // Si existe snapshot, usarlo
      const snapshot = snapshots[0];
      const closing = snapshot.closing;

      return {
        date: snapshot.date.toISOString().split('T')[0],
        opening: parseFloat(snapshot.opening.toString()),
        debit: parseFloat(snapshot.debit.toString()),
        credit: parseFloat(snapshot.credit.toString()),
        closing: parseFloat(closing.toString()),
        debtStatus: closing.isPositive()
          ? 'CXC'
          : closing.isNegative()
            ? 'CXP'
            : 'BALANCE',
        debtAmount: Math.abs(parseFloat(closing.toString())),
        description:
          closing.isPositive()
            ? `Le debemos ${Math.abs(parseFloat(closing.toString()))} al listero`
            : closing.isNegative()
              ? `El listero nos debe ${Math.abs(parseFloat(closing.toString()))}`
              : 'Balance cuadrado',
      };
    } catch (error) {
      logger.error({
        layer: 'service',
        action: 'DAILY_SUMMARY_FAIL',
        payload: {
          accountId,
          date: date.toISOString(),
          error: error instanceof Error ? error.message : 'Unknown',
        },
      });
      if (error instanceof AppError) throw error;
      throw new AppError('Failed to get daily summary', 500);
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

      logger.info({
        layer: 'service',
        action: 'LIST_ACCOUNTS_QUERY',
        payload: {
          filters,
          found: result.items.length,
          total: result.total
        },
      });

      const pageSize = filters.pageSize || 20;
      const page = filters.page || 1;

      // Build WHERE clause parts
      const whereClauseParts: string[] = ['1=1'];
      const params: any[] = [];

      if (filters.ownerType) {
        whereClauseParts.push(`a."ownerType" = $${params.length + 1}::"OwnerType"`);
        params.push(filters.ownerType);
      }
      if (filters.ownerId) {
        whereClauseParts.push(`a."ownerId" = $${params.length + 1}`);
        params.push(filters.ownerId);
      }
      if (filters.isActive !== undefined) {
        whereClauseParts.push(`a."isActive" = $${params.length + 1}`);
        params.push(filters.isActive);
      }

      // Add pagination params
      params.push(pageSize);
      params.push((page - 1) * pageSize);

      const accountMetrics = await prisma.$queryRawUnsafe<any[]>(
        `SELECT
          a.id,
          a."ownerType",
          a."ownerId",
          a.currency,
          a.balance,
          a."isActive",
          a."createdAt",
          COALESCE(SUM(CASE WHEN le.type = 'SALE' THEN le."valueSigned" ELSE 0 END), 0)::NUMERIC as "totalSalesAmount",
          COALESCE(SUM(CASE WHEN le.type = 'PAYOUT' THEN ABS(le."valueSigned") ELSE 0 END), 0)::NUMERIC as "totalPayoutsAmount",
          COALESCE(SUM(CASE WHEN le.type = 'COMMISSION' THEN le."valueSigned" ELSE 0 END), 0)::NUMERIC as "totalCommissionsAmount",
          COUNT(le.id)::INTEGER as "totalOperations"
        FROM "Account" a
        LEFT JOIN "LedgerEntry" le ON a.id = le."accountId"
        WHERE ${whereClauseParts.join(' AND ')}
        GROUP BY a.id, a."ownerType", a."ownerId", a.currency, a.balance, a."isActive", a."createdAt"
        ORDER BY a."createdAt" DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
        ...params
      );

      const accountsWithMetrics = accountMetrics.map(metric => {
        const balance = parseFloat(metric.balance.toString());
        const debtStatus = balance > 0 ? 'CXC' : balance < 0 ? 'CXP' : 'BALANCE';

        return {
          id: metric.id,
          ownerType: metric.ownerType,
          ownerId: metric.ownerId,
          currency: metric.currency,
          isActive: metric.isActive,
          createdAt: metric.createdAt,
          balance,
          metrics: {
            totalSales: parseFloat(metric.totalSalesAmount.toString()),
            totalPayouts: parseFloat(metric.totalPayoutsAmount.toString()),
            totalCommissions: parseFloat(metric.totalCommissionsAmount.toString()),
            totalOperations: metric.totalOperations,
          },
          debtStatus: {
            status: debtStatus,
            amount: Math.abs(balance),
            description:
              debtStatus === 'CXC'
                ? `Le debemos ${Math.abs(balance)} al listero`
                : debtStatus === 'CXP'
                  ? `El listero nos debe ${Math.abs(balance)}`
                  : 'Balance cuadrado',
          },
        };
      });

      return {
        accounts: accountsWithMetrics,
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

  /**
   * Calcular mayorización (saldos pendientes) para un período y cuenta
   * Basado en Ticket.totalAmount - Jugada.payout (donde isWinner=true)
   */
  static async calculateMayorization(
    accountId: string,
    filters: {
      fromDate: Date;
      toDate: Date;
      includeDesglose?: boolean;
    },
    userId: string
  ) {
    try {
      // 1. Validar cuenta existe
      const account = await AccountsRepository.getAccountById(accountId);
      if (!account) throw new AppError('Account not found', 404);

      // 2. Obtener ownerId para la query
      const ownerIdFilter = account.ownerId;

      // 3. Query SQL que calcula totalSales + totalPrizes
      const metrics = await prisma.$queryRawUnsafe<any[]>(`
        SELECT
          COALESCE(SUM(t."totalAmount"), 0)::NUMERIC as "totalSales",
          COALESCE(SUM(CASE
            WHEN j."isWinner" = true THEN j."payout"
            ELSE 0
          END), 0)::NUMERIC as "totalPrizes",
          COALESCE(SUM(CASE
            WHEN j."isWinner" = true THEN j."commissionAmount"
            ELSE 0
          END), 0)::NUMERIC as "totalCommission"
        FROM "Ticket" t
        LEFT JOIN "Jugada" j ON t."id" = j."ticketId"
          AND j."isWinner" = true
          AND j."deletedAt" IS NULL
        WHERE
          t."deletedAt" IS NULL
          AND t."status" IN ('ACTIVE', 'EVALUATED', 'PAID')
          AND t."createdAt" >= $1::TIMESTAMP
          AND t."createdAt" <= $2::TIMESTAMP
          AND (
            (t."ventanaId" = $3::UUID AND $4 = 'VENTANA')
            OR (t."vendedorId" = $3::UUID AND $4 = 'VENDEDOR')
          )
      `, filters.fromDate, filters.toDate, ownerIdFilter, account.ownerType);

      const raw = metrics[0];
      const totalSales = new Prisma.Decimal(raw.totalSales || 0);
      const totalPrizes = new Prisma.Decimal(raw.totalPrizes || 0);
      const totalCommission = new Prisma.Decimal(raw.totalCommission || 0);

      // 4. Obtener saldo anterior del día anterior para iniciar la mayorización
      const dayBeforeFromDate = new Date(filters.fromDate);
      dayBeforeFromDate.setDate(dayBeforeFromDate.getDate() - 1);

      const previousSnapshot = await prisma.dailyBalanceSnapshot.findUnique({
        where: {
          accountId_date: {
            accountId,
            date: new Date(dayBeforeFromDate.toDateString()),
          },
        },
      });

      const openingBalance = previousSnapshot?.closing || new Prisma.Decimal(0);

      // 5. Calcular período neto (ventas - premios pagados)
      const periodNeto = totalSales.minus(totalPrizes);

      // 6. Calcular neto operativo CUMULATIVO (saldo anterior + período neto)
      const netOperative = openingBalance.plus(periodNeto);

      // 7. Determinar estado de deuda
      const debtStatus = netOperative.isPositive()
        ? 'CXC'
        : netOperative.isNegative()
          ? 'CXP'
          : 'BALANCE';

      const debtAmount = netOperative.abs();
      const debtDescription = this.getDebtDescription(debtStatus, debtAmount);

      // 6. Crear o actualizar MayorizationRecord
      const mayorization = await prisma.mayorizationRecord.upsert({
        where: {
          accountId_fromDate_toDate: {
            accountId,
            fromDate: new Date(filters.fromDate.toDateString()),
            toDate: new Date(filters.toDate.toDateString()),
          },
        },
        create: {
          accountId,
          ownerType: account.ownerType,
          ownerId: account.ownerId,
          ownerName: account.ownerId, // TODO: buscar nombre real de Ventana o User
          fromDate: new Date(filters.fromDate.toDateString()),
          toDate: new Date(filters.toDate.toDateString()),
          totalSales,
          totalPrizes,
          totalCommission,
          netOperative,
          debtStatus,
          debtAmount,
          debtDescription,
          createdBy: userId,
        },
        update: {
          totalSales,
          totalPrizes,
          totalCommission,
          netOperative,
          debtStatus,
          debtAmount,
          debtDescription,
          computedAt: new Date(),
        },
      });

      // 8. Registrar en ActivityLog
      await ActivityService.log({
        userId,
        action: ActivityType.LEDGER_ADD,
        targetType: 'MAJORIZATION',
        targetId: mayorization.id,
        details: {
          accountId,
          period: `${filters.fromDate.toISOString().split('T')[0]} - ${filters.toDate.toISOString().split('T')[0]}`,
          openingBalance: openingBalance.toString(),
          totalSales: totalSales.toString(),
          totalPrizes: totalPrizes.toString(),
          periodNeto: periodNeto.toString(),
          netOperative: netOperative.toString(),
          debtStatus,
        },
        layer: 'service',
      });

      return mayorization;

    } catch (error) {
      logger.error({
        layer: 'service',
        action: 'MAJORIZATION_CALC_FAIL',
        payload: {
          accountId,
          error: error instanceof Error ? error.message : 'Unknown',
        },
      });
      if (error instanceof AppError) throw error;
      throw new AppError('Failed to calculate majorization', 500);
    }
  }

  /**
   * Obtener historial de mayorizaciones con filtros y paginación
   */
  static async getMayorizationHistory(
    filters: {
      period?: string;
      fromDate?: Date;
      toDate?: Date;
      ownerType?: OwnerType;
      ownerId?: string;
      debtStatus?: string;
      isSettled?: boolean;
      page?: number;
      pageSize?: number;
      orderBy?: 'date' | 'debtAmount' | 'netOperative';
      order?: 'asc' | 'desc';
    },
    user: any
  ) {
    try {
      // Construir WHERE con RBAC
      const where: Prisma.MayorizationRecordWhereInput = {};

      // RBAC: filtrar según rol
      if (user.role === 'VENTANA') {
        where.accountId = {
          in: await prisma.account.findMany({
            where: {
              ownerType: 'VENTANA',
              ownerId: user.ventanaId,
            },
            select: { id: true },
          }).then(accounts => accounts.map(a => a.id)),
        };
      } else if (user.role === 'VENDEDOR') {
        where.accountId = {
          in: await prisma.account.findMany({
            where: {
              ownerType: 'VENDEDOR',
              ownerId: user.id,
            },
            select: { id: true },
          }).then(accounts => accounts.map(a => a.id)),
        };
      }
      // ADMIN ve todo

      // Filtros adicionales
      if (filters.ownerType) where.ownerType = filters.ownerType;
      if (filters.ownerId) where.ownerId = filters.ownerId;
      if (filters.debtStatus) where.debtStatus = filters.debtStatus;
      if (filters.isSettled !== undefined) where.isSettled = filters.isSettled;

      // Filtro de fechas
      if (filters.fromDate || filters.toDate) {
        where.fromDate = {};
        if (filters.fromDate) where.fromDate.gte = filters.fromDate;
        if (filters.toDate) where.fromDate.lte = filters.toDate;
      }

      // Paginación
      const pageSize = filters.pageSize || 20;
      const page = filters.page || 1;
      const skip = (page - 1) * pageSize;

      // Ordenamiento
      const orderBy: Prisma.MayorizationRecordOrderByWithRelationInput = {};
      const sortField = filters.orderBy || 'date';
      const sortOrder = filters.order || 'desc';
      if (sortField === 'date') orderBy.fromDate = sortOrder;
      else if (sortField === 'debtAmount') orderBy.debtAmount = sortOrder;
      else if (sortField === 'netOperative') orderBy.netOperative = sortOrder;

      // Query
      const [mayorizations, total] = await Promise.all([
        prisma.mayorizationRecord.findMany({
          where,
          orderBy,
          skip,
          take: pageSize,
          include: { entries: true },
        }),
        prisma.mayorizationRecord.count({ where }),
      ]);

      // Transformar respuesta
      const transformed = mayorizations.map(m => ({
        id: m.id,
        accountId: m.accountId,
        ownerType: m.ownerType,
        ownerId: m.ownerId,
        ownerName: m.ownerName,
        period: {
          fromDate: m.fromDate,
          toDate: m.toDate,
        },
        metrics: {
          totalSales: parseFloat(m.totalSales.toString()),
          totalPrizes: parseFloat(m.totalPrizes.toString()),
          totalCommission: parseFloat(m.totalCommission.toString()),
          netOperative: parseFloat(m.netOperative.toString()),
        },
        debtStatus: {
          status: m.debtStatus,
          amount: parseFloat(m.debtAmount.toString()),
          description: m.debtDescription,
        },
        settlement: {
          isSettled: m.isSettled,
          settledDate: m.settledDate,
          settledAmount: m.settledAmount ? parseFloat(m.settledAmount.toString()) : null,
          type: m.settlementType,
          reference: m.settlementRef,
        },
        computedAt: m.computedAt,
      }));

      // Calcular summary
      const cxcTotal = await prisma.mayorizationRecord.aggregate({
        where: { ...where, debtStatus: 'CXC' },
        _sum: { debtAmount: true },
      });
      const cxpTotal = await prisma.mayorizationRecord.aggregate({
        where: { ...where, debtStatus: 'CXP' },
        _sum: { debtAmount: true },
      });

      return {
        mayorizations: transformed,
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
        },
        summary: {
          totalCXC: parseFloat((cxcTotal._sum.debtAmount || new Prisma.Decimal(0)).toString()),
          totalCXP: parseFloat((cxpTotal._sum.debtAmount || new Prisma.Decimal(0)).toString()),
          balance: parseFloat(
            ((cxcTotal._sum.debtAmount || new Prisma.Decimal(0))
              .minus(cxpTotal._sum.debtAmount || new Prisma.Decimal(0)))
              .toString()
          ),
        },
      };

    } catch (error) {
      logger.error({
        layer: 'service',
        action: 'MAJORIZATION_HISTORY_FAIL',
        payload: { error: error instanceof Error ? error.message : 'Unknown' },
      });
      throw new AppError('Failed to fetch majorization history', 500);
    }
  }

  /**
   * Registrar pago o cobro de una mayorización
   */
  static async settleMayorization(
    mayorizationId: string,
    data: {
      amount: number | Prisma.Decimal;
      settlementType: 'PAYMENT' | 'COLLECTION';
      date: Date;
      reference: string;
      note?: string;
      requestId?: string;
      createdBy: string;
    }
  ) {
    try {
      // 1. Obtener mayorización
      const mayorization = await prisma.mayorizationRecord.findUnique({
        where: { id: mayorizationId },
        include: { account: true },
      });
      if (!mayorization) throw new AppError('Majorization not found', 404);

      const amount = new Prisma.Decimal(data.amount);

      // 2. Validar idempotencia
      if (data.requestId) {
        const existing = await AccountsRepository.findEntryByRequestId(
          mayorization.accountId,
          data.requestId
        );
        if (existing) {
          return {
            mayorization,
            ledgerEntry: existing,
            newBalance: mayorization.account.balance,
          };
        }
      }

      // 3. Crear LEDGER ENTRY
      const valueSigned = data.settlementType === 'PAYMENT'
        ? amount.negated()
        : amount;

      const ledgerEntry = await AccountsRepository.addLedgerEntry(
        mayorization.accountId,
        {
          type: LedgerType.ADJUSTMENT,
          valueSigned,
          referenceType: ReferenceType.ADJUSTMENT_DOC,
          referenceId: mayorizationId,
          note: `${data.settlementType} - Ref: ${data.reference}${data.note ? ' (' + data.note + ')' : ''}`,
          requestId: data.requestId,
          createdBy: data.createdBy,
          date: data.date,
        }
      );

      // 4. Actualizar MayorizationRecord
      const updatedMajorization = await prisma.mayorizationRecord.update({
        where: { id: mayorizationId },
        data: {
          isSettled: true,
          settledDate: data.date,
          settledAmount: amount,
          settlementType: data.settlementType,
          settlementRef: data.reference,
          settlementEntryId: ledgerEntry.id,
          settledBy: data.createdBy,
        },
        include: { account: true },
      });

      // 5. Registrar en ActivityLog
      await ActivityService.log({
        userId: data.createdBy,
        action: ActivityType.LEDGER_ADD,
        targetType: 'SETTLEMENT',
        targetId: ledgerEntry.id,
        details: {
          mayorizationId,
          accountId: mayorization.accountId,
          type: data.settlementType,
          amount: amount.toString(),
          reference: data.reference,
        },
        requestId: data.requestId,
        layer: 'service',
      });

      // 6. Obtener nuevo balance
      const updatedAccount = await AccountsRepository.getAccountById(mayorization.accountId);

      return {
        mayorization: updatedMajorization,
        ledgerEntry,
        newBalance: updatedAccount!.balance,
      };

    } catch (error) {
      logger.error({
        layer: 'service',
        action: 'SETTLEMENT_FAIL',
        payload: {
          mayorizationId,
          error: error instanceof Error ? error.message : 'Unknown',
        },
      });
      if (error instanceof AppError) throw error;
      throw new AppError('Failed to settle majorization', 500);
    }
  }

  private static getDebtDescription(status: string, amount: Prisma.Decimal): string {
    const amountStr = parseFloat(amount.toString()).toLocaleString('es-CR', {
      style: 'currency',
      currency: 'CRC',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });

    return status === 'CXC'
      ? `Le debemos ${amountStr} al listero`
      : status === 'CXP'
        ? `El listero nos debe ${amountStr}`
        : 'Balance cuadrado';
  }
}

export default AccountsService;
