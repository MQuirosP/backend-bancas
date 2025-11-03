import { Router } from 'express';
import { protect } from '../../../middlewares/auth.middleware';
import { requireAdmin } from '../../../middlewares/roleGuards.middleware';
import AccountsController from '../controllers/accounts.controller';

const router = Router();

// Proteger todas las rutas
router.use(protect);

// Cuentas
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

// Depósitos
router.post('/:accountId/deposits', AccountsController.createBankDeposit);

// Snapshots
router.post('/:accountId/snapshots', AccountsController.createDailySnapshot);
router.get('/:accountId/snapshots', AccountsController.getDailySnapshots);

// Exportar
router.get('/:accountId/statement/export', AccountsController.exportStatement);

export default router;
