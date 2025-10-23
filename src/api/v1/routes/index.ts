import { Router } from 'express';
import authRoutes from './auth.routes';
import userRoutes from './user.routes';
import ticketRoutes from './ticket.routes';
import loteriaRoutes from './loteria.routes';
import ventanaRoutes from './ventana.routes';
import bancaRoutes from './banca.routes';
import vendedorRoutes from './vendedor.routes';
import sorteoRoutes from './sorteo.routes';
import userMultiplierOverrideRoutes from './userMultiplierOverride.routes';
import ventanaMultiplierOverrideRoutes from './ventanaMultiplierOverride.routes';
import restrictionRuleRoutes from './restrictionRule.routes'
import ticketPaymentRoutes from "./ticketPayment.route"
import multipliersRoutes from "./multipliers.routes"
import diagnosticsRoutes from "./diagnostics.routes"

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/tickets', ticketRoutes);
router.use('/loterias', loteriaRoutes);
router.use("/ventanas", ventanaRoutes);
router.use('/bancas', bancaRoutes);
router.use("/vendedores", vendedorRoutes);
router.use("/sorteos", sorteoRoutes);
router.use("/user-multiplier-overrides", userMultiplierOverrideRoutes);
router.use('/ventana-multiplier-overrides', ventanaMultiplierOverrideRoutes);
router.use("/restrictions", restrictionRuleRoutes);
router.use("/ticketPayment", ticketPaymentRoutes);
router.use("/multipliers", multipliersRoutes);
router.use("/diagnostics", diagnosticsRoutes);

export const apiV1Router = router;
