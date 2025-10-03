import express from 'express';
import { login, register } from '../controllers/auth.controller';
import { Role } from '@prisma/client';
import { restrictTo } from '../middlewares/auth.middleware';

const router = express.Router();

// Rutas públicas
router.post('/login', login);

// Rutas restringidas (solo el admin puede crear nuevos usuarios)
router.post('/register', restrictTo(Role.ADMIN), register);

export default router;
