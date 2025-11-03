import { Response } from 'express';
import { ZodError } from 'zod';
import { RequestWithUser } from '../../../core/types';
import AccountsService from '../services/accounts.service';
import {
  listAccountsQuerySchema,
  getAccountDetailsParamsSchema,
  getBalanceParamsSchema,
  listLedgerEntriesQuerySchema,
  getBalanceSummaryParamsSchema,
  getDailySnapshotsQuerySchema,
  addSaleEntrySchema,
  addCommissionEntrySchema,
  addPayoutEntrySchema,
  createBankDepositSchema,
  reverseEntrySchema,
  createDailySnapshotSchema,
  updateAccountSchema,
  createPaymentDocumentSchema,
  createAccountSchema,
  closeDaySchema,
  getDailySummarySchema,
} from '../validators/accounts.validator';
import logger from '../../../core/logger';

const sendSuccess = (res: Response, data: any, statusCode: number = 200) => {
  res.status(statusCode).json({ success: true, data });
};

const sendError = (res: Response, error: any) => {
  if (error instanceof Error && 'statusCode' in error) {
    const appErr = error as any;
    return res.status(appErr.statusCode).json({
      success: false,
      error: { message: appErr.message, code: appErr.statusCode },
    });
  }

  if (error instanceof ZodError) {
    return res.status(400).json({
      success: false,
      error: { message: 'Validation error', code: 'VALIDATION_ERROR' },
    });
  }

  logger.error({
    layer: 'controller',
    action: 'UNEXPECTED_ERROR',
    payload: { error: error instanceof Error ? error.message : 'Unknown' },
  });
  return res.status(500).json({
    success: false,
    error: { message: 'Internal server error', code: 'INTERNAL_ERROR' },
  });
};

export class AccountsController {
  static async listAccounts(req: RequestWithUser, res: Response) {
    try {
      const query = listAccountsQuerySchema.parse(req.query);
      const accounts = await AccountsService.listAccounts(query);
      sendSuccess(res, accounts);
    } catch (error) {
      sendError(res, error);
    }
  }

  static async createAccount(req: RequestWithUser, res: Response) {
    try {
      const data = createAccountSchema.parse(req.body);
      const account = await AccountsService.createAccount({
        ...data,
        createdBy: req.user!.id,
      });
      sendSuccess(res, account, 201);
    } catch (error) {
      sendError(res, error);
    }
  }

  static async getAccountDetails(req: RequestWithUser, res: Response) {
    try {
      const params = getAccountDetailsParamsSchema.parse({ accountId: req.params.accountId });
      const account = await AccountsService.getAccountDetails(params.accountId);
      sendSuccess(res, account);
    } catch (error) {
      sendError(res, error);
    }
  }

  static async getBalance(req: RequestWithUser, res: Response) {
    try {
      const params = getBalanceParamsSchema.parse({ accountId: req.params.accountId });
      const balance = await AccountsService.getBalance(params.accountId);
      sendSuccess(res, balance);
    } catch (error) {
      sendError(res, error);
    }
  }

  static async updateAccount(req: RequestWithUser, res: Response) {
    try {
      const accountId = req.params.accountId;
      const data = updateAccountSchema.parse(req.body);
      const updated = await AccountsService.updateAccount(accountId, data, req.user!.id);
      sendSuccess(res, updated);
    } catch (error) {
      sendError(res, error);
    }
  }

  static async listLedgerEntries(req: RequestWithUser, res: Response) {
    try {
      const query = listLedgerEntriesQuerySchema.parse({
        ...req.query,
        accountId: req.params.accountId,
      });
      const result = await AccountsService.listLedgerEntries(query.accountId, query);
      sendSuccess(res, result);
    } catch (error) {
      sendError(res, error);
    }
  }

  static async addSaleEntry(req: RequestWithUser, res: Response) {
    try {
      const accountId = req.params.accountId;
      const data = addSaleEntrySchema.parse(req.body);
      const entry = await AccountsService.addSaleEntry(accountId, {
        ...data,
        createdBy: req.user!.id,
      });
      sendSuccess(res, entry, 201);
    } catch (error) {
      sendError(res, error);
    }
  }

  static async addCommissionEntry(req: RequestWithUser, res: Response) {
    try {
      const accountId = req.params.accountId;
      const data = addCommissionEntrySchema.parse(req.body);
      const entry = await AccountsService.addCommissionEntry(accountId, {
        ...data,
        createdBy: req.user!.id,
      });
      sendSuccess(res, entry, 201);
    } catch (error) {
      sendError(res, error);
    }
  }

  static async addPayoutEntry(req: RequestWithUser, res: Response) {
    try {
      const accountId = req.params.accountId;
      const data = addPayoutEntrySchema.parse(req.body);
      const entry = await AccountsService.addPayoutEntry(accountId, {
        ...data,
        createdBy: req.user!.id,
      });
      sendSuccess(res, entry, 201);
    } catch (error) {
      sendError(res, error);
    }
  }

  static async reverseEntry(req: RequestWithUser, res: Response) {
    try {
      const { accountId, entryId } = req.params;
      const data = reverseEntrySchema.parse(req.body);
      const reversal = await AccountsService.reverseEntry(accountId, entryId, {
        ...data,
        createdBy: req.user!.id,
      });
      sendSuccess(res, reversal, 201);
    } catch (error) {
      sendError(res, error);
    }
  }

  static async getBalanceSummary(req: RequestWithUser, res: Response) {
    try {
      const params = getBalanceSummaryParamsSchema.parse({ accountId: req.params.accountId });
      const summary = await AccountsService.getBalanceSummary(params.accountId);
      sendSuccess(res, summary);
    } catch (error) {
      sendError(res, error);
    }
  }

  static async createBankDeposit(req: RequestWithUser, res: Response) {
    try {
      const accountId = req.params.accountId;
      const data = createBankDepositSchema.parse(req.body);
      const deposit = await AccountsService.createBankDeposit(accountId, {
        ...data,
        createdBy: req.user!.id,
      });
      sendSuccess(res, deposit, 201);
    } catch (error) {
      sendError(res, error);
    }
  }

  static async createDailySnapshot(req: RequestWithUser, res: Response) {
    try {
      const accountId = req.params.accountId;
      const data = createDailySnapshotSchema.parse(req.body);
      const snapshot = await AccountsService.createDailySnapshot(accountId, data.date, {
        opening: data.opening,
        debit: data.debit,
        credit: data.credit,
        closing: data.closing,
        createdBy: req.user!.id,
      });
      sendSuccess(res, snapshot, 201);
    } catch (error) {
      sendError(res, error);
    }
  }

  static async getDailySnapshots(req: RequestWithUser, res: Response) {
    try {
      const query = getDailySnapshotsQuerySchema.parse({
        ...req.query,
        accountId: req.params.accountId,
      });
      const snapshots = await AccountsService.getDailySnapshots(query.accountId, query.from, query.to);
      sendSuccess(res, { snapshots });
    } catch (error) {
      sendError(res, error);
    }
  }

  static async exportStatement(req: RequestWithUser, res: Response) {
    try {
      const { from, to } = getDailySnapshotsQuerySchema.parse({
        ...req.query,
        accountId: req.params.accountId,
      });
      const statement = await AccountsService.exportStatement(
        req.params.accountId,
        from,
        to,
        req.user!.id
      );
      sendSuccess(res, statement);
    } catch (error) {
      sendError(res, error);
    }
  }

  static async getDailyLedgerSummary(req: RequestWithUser, res: Response) {
    try {
      const params = getBalanceSummaryParamsSchema.parse({ accountId: req.params.accountId });
      const from = req.query.from ? new Date(req.query.from as string) : undefined;
      const to = req.query.to ? new Date(req.query.to as string) : undefined;
      const summary = await AccountsService.getDailyLedgerSummary(params.accountId, { from, to });
      sendSuccess(res, summary);
    } catch (error) {
      sendError(res, error);
    }
  }

  static async createPaymentDocument(req: RequestWithUser, res: Response) {
    try {
      const data = createPaymentDocumentSchema.parse(req.body);
      const paymentDoc = await AccountsService.createPaymentDocument({
        ...data,
        createdBy: req.user!.id,
      });
      sendSuccess(res, paymentDoc, 201);
    } catch (error) {
      sendError(res, error);
    }
  }

  static async getDailySummary(req: RequestWithUser, res: Response) {
    try {
      const params = getDailySummarySchema.parse({
        accountId: req.params.accountId,
        date: req.query.date as string,
      });
      const summary = await AccountsService.getDailySummary(params.accountId, params.date);
      sendSuccess(res, summary);
    } catch (error) {
      sendError(res, error);
    }
  }

  static async closeDay(req: RequestWithUser, res: Response) {
    try {
      const accountId = req.params.accountId;
      const data = closeDaySchema.parse(req.body);
      const result = await AccountsService.closeDay(accountId, {
        date: data.date,
        createdBy: req.user!.id,
      });
      sendSuccess(res, result, 201);
    } catch (error) {
      sendError(res, error);
    }
  }
}

export default AccountsController;
