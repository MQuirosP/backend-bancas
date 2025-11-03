import { Router } from 'express';
import { protect } from '../../../middlewares/auth.middleware';
import { requireAdmin } from '../../../middlewares/roleGuards.middleware';
import AccountsController from '../controllers/accounts.controller';

const router = Router();

// Proteger todas las rutas
router.use(protect);

// Cuentas
router.post('/', requireAdmin, AccountsController.createAccount);
router.get('/', AccountsController.listAccounts);
router.get('/:accountId', AccountsController.getAccountDetails);
router.get('/:accountId/balance', AccountsController.getBalance);
router.put('/:accountId', requireAdmin, AccountsController.updateAccount);

// Entradas ledger
router.get('/:accountId/entries', AccountsController.listLedgerEntries);
router.post('/:accountId/entries/sale', AccountsController.addSaleEntry);
router.post('/:accountId/entries/commission', AccountsController.addCommissionEntry);
router.post('/:accountId/entries/payout', AccountsController.addPayoutEntry);
router.post('/:accountId/entries/:entryId/reverse', requireAdmin, AccountsController.reverseEntry);

// Resumen
router.get('/:accountId/summary', AccountsController.getBalanceSummary);

// Ledger diario con estado CXC/CXP
router.get('/:accountId/ledger-summary', AccountsController.getDailyLedgerSummary);

// Depósitos
router.post('/:accountId/deposits', AccountsController.createBankDeposit);

// Documentos de pago entre cuentas
router.post('/payments', AccountsController.createPaymentDocument);

// Snapshots
router.post('/:accountId/snapshots', AccountsController.createDailySnapshot);
router.get('/:accountId/snapshots', AccountsController.getDailySnapshots);

// Resumen diario
router.get('/:accountId/daily-summary', AccountsController.getDailySummary);

// Cierre diario
router.post('/:accountId/daily-close', AccountsController.closeDay);

// Exportar
router.get('/:accountId/statement/export', AccountsController.exportStatement);

export default router;
