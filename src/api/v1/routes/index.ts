import { Router } from 'express';
import authRoutes from './auth.routes';
// import ticketRoutes from './ticket.routes';
// import loteriaRoutes from './loteria.routes';

const router = Router();

router.use('/auth', authRoutes);
// router.use('/tickets', ticketRoutes);
// router.use('/loterias', loteriaRoutes);

export const apiV1Router = router;
