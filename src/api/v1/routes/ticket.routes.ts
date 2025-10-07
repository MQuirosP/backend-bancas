import { Router } from 'express';
import { TicketController } from '../controllers/ticket.controller';
import { validateBody, validateParams } from '../../../middlewares/validate.middleware';
import { createTicketSchema } from '../validators/ticket.validator';
import { protect, restrictTo } from '../../../middlewares/auth.middleware';
import { Role } from '@prisma/client';

const router = Router();

router.use(protect)
router.use(restrictTo(Role.VENDEDOR, Role.VENTANA, Role.ADMIN))

router.post('/', validateBody(createTicketSchema), TicketController.create);
router.get('/:id', TicketController.getById);
router.get('/', TicketController.list);
router.patch('/:id/cancel', TicketController.cancel);

export default router;
