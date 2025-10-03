import express from 'express';
import { getTicketById, getSalesReport } from '../controllers/report.controller';
import { protect } from '../middlewares/auth.middleware';

const router = express.Router();

// Todas las rutas de reportes requieren autenticación (protect)
router.use(protect); 

// Reporte de Ventas (Filtros dinámicos según el rol en el controlador)
router.get('/sales', getSalesReport); 

// Consulta de Tiquete por ID (Filtro de seguridad por pertenencia en el controlador)
router.get('/tickets/:id', getTicketById); 

export default router;
