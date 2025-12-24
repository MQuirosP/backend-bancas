import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { validateBody } from '../../../middlewares/validate.middleware';
import { registerSchema, loginSchema, setActiveBancaSchema } from '../validators/auth.validator';
import { updateUserSchema } from '../validators/user.validator';
import { protect } from '../../../middlewares/auth.middleware';

const router = Router();

router.post('/register', validateBody(registerSchema), AuthController.register);
router.post('/login', validateBody(loginSchema), AuthController.login);
router.post('/refresh', AuthController.refresh);
router.post('/logout', AuthController.logout);
router.get('/me', protect, AuthController.me);
router.patch('/me', protect, validateBody(updateUserSchema), AuthController.updateMe);
router.post('/set-active-banca', protect, validateBody(setActiveBancaSchema), AuthController.setActiveBanca);

export default router;
