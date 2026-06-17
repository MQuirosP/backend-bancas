import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { validateBody } from '../../../middlewares/validate.middleware';
import { authRateLimiter } from '../../../middlewares/rateLimit.middleware';
import { registerSchema, loginSchema, setActiveBancaSchema } from '../validators/auth.validator';
import { updateUserSchema } from '../validators/user.validator';
import { protect, restrictTo } from '../../../middlewares/auth.middleware';
import { Role } from '../../../generated/prisma/client';

const router = Router();

router.post('/register', validateBody(registerSchema), AuthController.register);
router.post('/login', authRateLimiter, validateBody(loginSchema), AuthController.login);
router.post('/refresh', AuthController.refresh);
router.post('/logout', AuthController.logout);
router.get('/me', protect, AuthController.me);
router.patch('/me', protect, validateBody(updateUserSchema), AuthController.updateMe);
router.post('/set-active-banca', protect, restrictTo(Role.ADMIN, Role.BANCA), validateBody(setActiveBancaSchema), AuthController.setActiveBanca);

// Endpoints de sesiones (multi-dispositivo)
router.get('/sessions/user/:userId', protect, AuthController.getUserSessions);
router.delete('/sessions/:sessionId', protect, AuthController.revokeSession);
router.post('/logout/all', protect, AuthController.logoutAll);

export default router;
