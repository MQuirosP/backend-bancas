import express from 'express';
import { createTicket } from '../controllers/ticket.controller';
import { Role } from '@prisma/client';
import { protect, restrictTo } from '../middlewares/auth.middleware';

const router = express.Router();

// La venta de tiquetes es la ruta más crítica
router.post('/', protect, restrictTo(Role.ADMIN, Role.VENTANA, Role.VENDEDOR), createTicket);

export default router;
