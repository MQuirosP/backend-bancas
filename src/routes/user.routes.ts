import express from 'express';
import { Role } from '@prisma/client';
import {
    createBanca,
    getAllBancas,
    deleteBanca,
    createVentana,
    deleteVentana,
    createUser,
    getAllUsers,
    deleteUser,
    restoreEntity
} from '../controllers/user.controller';
import { protect, restrictTo } from '../middlewares/auth.middleware';

const router = express.Router();

// Todas las rutas de administración están protegidas y restringidas al rol ADMIN
router.use(protect, restrictTo(Role.ADMIN));

// --- Rutas de Banca ---
router.route('/bancas')
    .post(createBanca)
    .get(getAllBancas);

router.route('/bancas/:id')
    .delete(deleteBanca); // Soft-delete

// --- Rutas de Ventana ---
router.route('/ventanas')
    .post(createVentana);

router.route('/ventanas/:id')
    .delete(deleteVentana); // Soft-delete

// --- Rutas de Usuarios ---
router.route('/users')
    .post(createUser) // Crear (Vendedor, Ventana, Admin)
    .get(getAllUsers);

router.route('/users/:id')
    .delete(deleteUser); // Soft-delete

// --- Rutas de Mantenimiento ---
router.route('/restore/:id')
    .post(restoreEntity); // Restaurar cualquier entidad (User, Banca, Ventana)

export default router;
