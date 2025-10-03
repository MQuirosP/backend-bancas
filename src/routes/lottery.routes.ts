import express from 'express';
import { Role } from '@prisma/client';
import {
    createLoteria,
    getAllLoterias,
    upsertBancaLoteriaSetting,
    getBancaLoteriaSetting
} from '../controllers/lottery.controller';
import { protect, restrictTo } from '../middlewares/auth.middleware';

const router = express.Router();

// Todas las rutas de lotería están protegidas y restringidas al rol ADMIN
router.use(protect, restrictTo(Role.ADMIN));

// --- Rutas de Lotería Base ---
router.route('/')
    .post(createLoteria) // Crear una nueva Lotería
    .get(getAllLoterias); // Obtener todas las Loterías

// --- Rutas de Configuración por Banca (CRÍTICO) ---
router.route('/settings')
    .post(upsertBancaLoteriaSetting); // Crear/Actualizar la configuración (multiplicadores)

router.route('/settings/:bancaId/:loteriaId')
    .get(getBancaLoteriaSetting); // Obtener configuración específica

export default router;
