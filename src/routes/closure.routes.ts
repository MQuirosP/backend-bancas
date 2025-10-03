import express from 'express';
import { Role } from '@prisma/client';
import { processLotteryClosure } from '../controllers/closure.controller';
import { protect, restrictTo } from '../middlewares/auth.middleware';

const router = express.Router();

// Las rutas de cierre son CRÍTICAS y solo pueden ser accedidas por el ADMIN
router.use(protect, restrictTo(Role.ADMIN));

// Procesa un cierre de sorteo con el número ganador
router.post('/process', processLotteryClosure); 

// (Aquí se añadirían rutas para pagar premios, anular tiquetes pagados, etc.)

export default router;
