import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { validateBody } from '../../../middlewares/validate.middleware';
import { registerSchema, loginSchema } from '../validators/auth.validator';
import { protect } from '../../../middlewares/auth.middleware';

const router = Router();

router.post('/register', validateBody(registerSchema), AuthController.register);
router.post('/login', validateBody(loginSchema), AuthController.login);
router.post('/refresh', AuthController.refresh);
router.post('/logout', AuthController.logout);
router.get('/me', protect, AuthController.me);

export default router;
