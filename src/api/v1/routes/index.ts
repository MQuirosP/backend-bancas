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
import restrictionRule from './restrictionRule.routes'
import ticketPayment from "./ticketPayment.route"

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/tickets', ticketRoutes);
router.use('/loterias', loteriaRoutes);
router.use("/ventanas", ventanaRoutes);
router.use('/bancas', bancaRoutes);
router.use("/vendedores", vendedorRoutes);
router.use("/sorteos", sorteoRoutes);
router.use("/multiplierOverride", multiplierOverrideRoutes);
router.use("/restrictionRule", restrictionRule);
router.use("/ticketPayment", ticketPayment);

export const apiV1Router = router;
