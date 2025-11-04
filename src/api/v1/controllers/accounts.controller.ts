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
  calculateMayorizationSchema,
  getMayorizationHistorySchema,
  settleMayorizationSchema,
} from '../validators/accounts.validator';
import logger from '../../../core/logger';
import ActivityService from '../../../core/activity.service';

const sendSuccess = (res: Response, data: any, statusCode: number = 200) => {
  res.status(statusCode).json({ success: true, data });
};

const sendError = (res: Response, error: any, action: string = 'UNKNOWN_ACTION', userId?: string) => {
  let statusCode = 500;
  let message = 'Internal server error';
  let code = 'INTERNAL_ERROR';
  let details: any = undefined;

  if (error instanceof Error && 'statusCode' in error) {
    const appErr = error as any;
    statusCode = appErr.statusCode;
    message = appErr.message;
    code = appErr.code || appErr.statusCode;
    details = appErr.details;
  } else if (error instanceof ZodError) {
    statusCode = 400;
    message = 'Validation error';
    code = 'VALIDATION_ERROR';
    details = (error as any).errors || error.issues;
  }

  // Log error with context
  logger.error({
    layer: 'controller',
    action,
    payload: {
      statusCode,
      message,
      code,
      details,
      errorMsg: error instanceof Error ? error.message : String(error),
    },
  });

  // Log to activity for critical errors
  if (userId && statusCode >= 400) {
    ActivityService.log({
      userId,
      action: 'SYSTEM_ACTION',
      targetType: 'ERROR',
      details: {
        controller_action: action,
        http_status: statusCode,
        error_code: code,
        error_message: message,
      },
      layer: 'controller',
    }).catch(e => logger.error({ layer: 'controller', action: 'ACTIVITY_LOG_ERROR', payload: { error: e.message } }));
  }

  return res.status(statusCode).json({
    success: false,
    error: { message, code },
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
    const userId = req.user!.id;
    const action = 'CREATE_ACCOUNT';

    try {
      const data = createAccountSchema.parse(req.body);

      logger.info({
        layer: 'controller',
        action,
        payload: { userId, ownerType: data.ownerType, ownerId: data.ownerId },
      });

      const account = await AccountsService.createAccount({
        ...data,
        createdBy: userId,
      });

      logger.info({
        layer: 'controller',
        action,
        payload: { userId, accountId: account.id, success: true },
      });

      sendSuccess(res, account, 201);
    } catch (error) {
      sendError(res, error, action, userId);
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
    const userId = req.user!.id;
    const action = 'ADD_SALE_ENTRY';

    try {
      const accountId = req.params.accountId;
      const data = addSaleEntrySchema.parse(req.body);

      logger.info({
        layer: 'controller',
        action,
        payload: { userId, accountId, ticketId: data.ticketId, amount: data.amount },
      });

      const entry = await AccountsService.addSaleEntry(accountId, {
        ...data,
        createdBy: userId,
      });

      sendSuccess(res, entry, 201);
    } catch (error) {
      sendError(res, error, action, userId);
    }
  }

  static async addCommissionEntry(req: RequestWithUser, res: Response) {
    const userId = req.user!.id;
    const action = 'ADD_COMMISSION_ENTRY';

    try {
      const accountId = req.params.accountId;
      const data = addCommissionEntrySchema.parse(req.body);

      logger.info({
        layer: 'controller',
        action,
        payload: { userId, accountId, ticketId: data.ticketId, commissionRate: data.commissionRate },
      });

      const entry = await AccountsService.addCommissionEntry(accountId, {
        ...data,
        createdBy: userId,
      });

      sendSuccess(res, entry, 201);
    } catch (error) {
      sendError(res, error, action, userId);
    }
  }

  static async addPayoutEntry(req: RequestWithUser, res: Response) {
    const userId = req.user!.id;
    const action = 'ADD_PAYOUT_ENTRY';

    try {
      const accountId = req.params.accountId;
      const data = addPayoutEntrySchema.parse(req.body);

      logger.info({
        layer: 'controller',
        action,
        payload: { userId, accountId, payoutId: data.payoutId, amount: data.amount },
      });

      const entry = await AccountsService.addPayoutEntry(accountId, {
        ...data,
        createdBy: userId,
      });

      sendSuccess(res, entry, 201);
    } catch (error) {
      sendError(res, error, action, userId);
    }
  }

  static async reverseEntry(req: RequestWithUser, res: Response) {
    const userId = req.user!.id;
    const action = 'REVERSE_ENTRY';

    try {
      const { accountId, entryId } = req.params;
      const data = reverseEntrySchema.parse(req.body);

      logger.info({
        layer: 'controller',
        action,
        payload: { userId, accountId, entryId, reason: data.reason },
      });

      const reversal = await AccountsService.reverseEntry(accountId, entryId, {
        ...data,
        createdBy: userId,
      });

      sendSuccess(res, reversal, 201);
    } catch (error) {
      sendError(res, error, action, userId);
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
    const userId = req.user!.id;
    const action = 'CREATE_BANK_DEPOSIT';

    try {
      const accountId = req.params.accountId;
      const data = createBankDepositSchema.parse(req.body);

      logger.info({
        layer: 'controller',
        action,
        payload: { userId, accountId, amount: data.amount, docNumber: data.docNumber },
      });

      const deposit = await AccountsService.createBankDeposit(accountId, {
        ...data,
        createdBy: userId,
      });

      sendSuccess(res, deposit, 201);
    } catch (error) {
      sendError(res, error, action, userId);
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
    const userId = req.user!.id;
    const action = 'CLOSE_DAY';

    try {
      const accountId = req.params.accountId;
      const data = closeDaySchema.parse(req.body);

      logger.info({
        layer: 'controller',
        action,
        payload: { userId, accountId, date: data.date.toISOString().split('T')[0] },
      });

      const result = await AccountsService.closeDay(accountId, {
        date: data.date,
        createdBy: userId,
      });

      logger.info({
        layer: 'controller',
        action,
        payload: { userId, accountId, success: true },
      });

      sendSuccess(res, result, 201);
    } catch (error) {
      sendError(res, error, action, userId);
    }
  }

  static async calculateMajorization(req: RequestWithUser, res: Response) {
    const userId = req.user!.id;
    const action = 'CALCULATE_MAYORIZATION';

    try {
      const accountId = req.params.accountId;
      const data = calculateMayorizationSchema.parse({
        ...req.query,
        accountId,
      });

      logger.info({
        layer: 'controller',
        action,
        payload: {
          userId,
          accountId,
          fromDate: data.fromDate.toISOString().split('T')[0],
          toDate: data.toDate.toISOString().split('T')[0],
        },
      });

      const result = await AccountsService.calculateMayorization(
        data.accountId,
        {
          fromDate: data.fromDate,
          toDate: data.toDate,
          includeDesglose: data.includeDesglose,
        },
        userId
      );

      logger.info({
        layer: 'controller',
        action,
        payload: { userId, accountId, success: true },
      });

      sendSuccess(res, result, 201);
    } catch (error) {
      sendError(res, error, action, userId);
    }
  }

  static async getMayorizationHistory(req: RequestWithUser, res: Response) {
    const userId = req.user!.id;
    const action = 'GET_MAYORIZATION_HISTORY';

    try {
      logger.info({
        layer: 'controller',
        action,
        payload: {
          userId,
          query: req.query,
        },
      });

      const queryRaw = getMayorizationHistorySchema.parse(req.query);
      const query = {
        ...queryRaw,
        fromDate: queryRaw.fromDate ? new Date(queryRaw.fromDate) : undefined,
        toDate: queryRaw.toDate ? new Date(queryRaw.toDate) : undefined,
      };

      const result = await AccountsService.getMayorizationHistory(query, req.user!);

      logger.info({
        layer: 'controller',
        action,
        payload: {
          userId,
          resultCount: result.data?.length || 0,
          totalPages: result.pagination?.totalPages,
        },
      });

      res.status(200).json({
        success: true,
        mayorizations: result.data,
        pagination: result.pagination,
        summary: result.summary,
      });
    } catch (error) {
      sendError(res, error, action, userId);
    }
  }

  static async settleMayorization(req: RequestWithUser, res: Response) {
    const userId = req.user!.id;
    const action = 'SETTLE_MAYORIZATION';

    try {
      const bodyData = settleMayorizationSchema.parse(req.body);

      logger.info({
        layer: 'controller',
        action,
        payload: {
          userId,
          mayorizationId: bodyData.mayorizationId,
          accountId: bodyData.accountId,
          amount: bodyData.amount,
          settlementType: bodyData.settlementType,
        },
      });

      const result = await AccountsService.settleMayorization(bodyData.mayorizationId, {
        accountId: bodyData.accountId,
        amount: bodyData.amount,
        settlementType: bodyData.settlementType,
        date: bodyData.date,
        reference: bodyData.reference,
        note: bodyData.note,
        requestId: bodyData.requestId,
        createdBy: userId,
      });

      logger.info({
        layer: 'controller',
        action,
        payload: {
          userId,
          mayorizationId: bodyData.mayorizationId,
          accountId: bodyData.accountId,
          success: true,
        },
      });

      sendSuccess(res, result, 201);
    } catch (error) {
      sendError(res, error, action, userId);
    }
  }
}

export default AccountsController;
