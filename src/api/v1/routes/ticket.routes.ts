import { Router } from 'express';
import { TicketController } from '../controllers/ticket.controller';
import { validateBody, validateParams } from '../../../middlewares/validate.middleware';
import { createTicketSchema } from '../validators/ticket.validator';

const router = Router();

router.post('/', validateBody(createTicketSchema), TicketController.create);
router.get('/:id', TicketController.getById);
router.get('/', TicketController.list);
router.patch('/:id/cancel', TicketController.cancel);

export default router;
