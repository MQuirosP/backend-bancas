import { Router } from 'express';
import authRoutes from './auth.routes';
import userRoutes from './user.routes';
import ticketRoutes from './ticket.routes';
import loteriaRoutes from './loteria.routes';
import ventanaRoutes from './ventana.routes';
import bancaRoutes from './banca.routes';
import vendedorRoutes from './vendedor.routes';
import sorteoRoutes from './sorteo.routes';
import multiplierOverrideRoutes from './multiplierOverride.routes';
import restrictionRuleRoutes from './restrictionRule.routes'
import ticketPaymentRoutes from "./ticketPayment.route"
import multipliersRoutes from "./multipliers.routes"
import diagnosticsRoutes from "./diagnostics.routes"
import ventaRoutes from "./venta.routes"
import commissionRoutes from "./commission.routes"
import dashboardRoutes from "./dashboard.routes"
import activityLogRoutes from "./activityLog.routes"
import cierreRoutes from "./cierre.routes"
import commissionsRoutes from "./commissions.routes"
import accountsRoutes from "./accounts.routes"

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/tickets', ticketRoutes);
router.use('/loterias', loteriaRoutes);
router.use("/ventanas", ventanaRoutes);
router.use('/bancas', bancaRoutes);
router.use("/vendedores", vendedorRoutes);
router.use("/sorteos", sorteoRoutes);
router.use("/multiplier-overrides", multiplierOverrideRoutes);
router.use("/restrictions", restrictionRuleRoutes);
router.use("/ticket-payments", ticketPaymentRoutes);
router.use("/multipliers", multipliersRoutes);
router.use("/diagnostics", diagnosticsRoutes);
router.use("/ventas", ventaRoutes);
router.use("/admin/dashboard", dashboardRoutes);
router.use("/activity-logs", activityLogRoutes);
router.use("/cierres", cierreRoutes);
router.use("/commissions", commissionsRoutes);
router.use("/accounts", accountsRoutes);
router.use("/", commissionRoutes); // Commission routes include their own path prefixes (políticas de comisión)

export const apiV1Router = router;
