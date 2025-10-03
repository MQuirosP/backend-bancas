import { Request, Response, NextFunction } from 'express';
import { PrismaClient, Role, ActivityType } from '@prisma/client';
import { restrictTo } from '../middlewares/auth.middleware';
import express from 'express';


const prisma = new PrismaClient();

// Extender el Request de Express para incluir el usuario autenticado
interface CustomRequest extends Request {
  user?: {
    id: string;
    role: Role;
    ventanaId?: string;
  };
}

/**
 * Función CRÍTICA: Crea un tiquete y sus jugadas en una sola transacción.
 * Incluye la llamada al PostgreSQL Function para el número atómico.
 * (POST /api/tickets)
 */
export const createTicket = async (req: CustomRequest, res: Response) => {
  const { loteriaId, ventanaId, vendedorId, jugadas, totalAmount } = req.body;
  const authUser = req.user;

  if (!authUser) {
    return res.status(401).json({ status: 'fail', message: 'Usuario no autenticado.' });
  }

  // VALIDACIÓN DE ROL Y JERARQUÍA (CRÍTICO)
  // El usuario logueado (authUser) debe tener permiso para vender por el vendedorId especificado.
  if (authUser.role === Role.VENTANA && authUser.ventanaId !== ventanaId) {
      return res.status(403).json({ status: 'fail', message: 'La Ventana logueada no puede vender para otra Ventana.' });
  }
  if (authUser.role === Role.VENDEDOR && authUser.id !== vendedorId) {
      return res.status(403).json({ status: 'fail', message: 'El Vendedor solo puede vender por sí mismo.' });
  }

  // INICIO DE LA TRANSACCIÓN ATÓMICA
  try {
    // 1. Llamar a la función PostgreSQL para el número de tiquete atómico
    // Nota: El método `query` de Prisma llama a SQL nativo.
    const ticketResult: { new_ticket_number: number }[] = await prisma.$queryRaw`SELECT generate_ticket_number() as new_ticket_number`;
    const ticketNumber = ticketResult[0].new_ticket_number;

    // 2. Bloqueo Horario (Simulación de la verificación en el servidor)
    // LÓGICA CRÍTICA: Aquí se verificaría la hora del servidor vs. hora de cierre de la lotería.
    // if (isClosed(loteriaId)) throw new Error('Venta fuera del horario permitido.');
    
    // 3. Buscar la configuración de la Banca para obtener el Multiplicador Base y Margen
    // LÓGICA CRÍTICA: Aquí se calcularía el finalMultiplierX y se registraría.
    const ventana = await prisma.ventana.findUnique({ where: { id: ventanaId } });
    const setting = await prisma.bancaLoteriaSetting.findFirst({ where: { loteriaId, bancaId: ventana?.bancaId } });
    
    if (!setting) throw new Error('Configuración de lotería no encontrada para esta Banca.');
    
    const baseMultiplier = setting.baseMultiplierX;
    const commissionMargin = ventana?.commissionMarginX || 0; // Margen de la ventana

    // Simulación: Asumimos que el finalMultiplierX es el Base - Margen de Ventana
    const finalPayoutMultiplier = baseMultiplier - commissionMargin; 

    // 4. Crear el Tiquete y las Jugadas en una Transacción (Prisma)
    const newTicket = await prisma.$transaction(async (tx) => {
      // 4a. Crear el Tiquete
      const ticket = await tx.ticket.create({
        data: {
          ticketNumber,
          loteriaId,
          ventanaId,
          vendedorId,
          totalAmount,
        },
      });

      // 4b. Crear las Jugadas
      const jugadasData = jugadas.map((j: any) => ({
        ticketId: ticket.id,
        number: j.number,
        amount: j.amount,
        finalMultiplierX: finalPayoutMultiplier, // CRÍTICO: Registra el multiplicador final
        payout: j.amount * finalPayoutMultiplier,
      }));

      await tx.jugada.createMany({ data: jugadasData });

      // 4c. Registrar en el ActivityLog
      await tx.activityLog.create({
        data: {
          userId: authUser.id,
          action: ActivityType.TICKET_CREATE,
          targetType: 'TICKET',
          targetId: ticket.id,
          details: { ticketNumber, totalAmount },
        },
      });

      return ticket;
    });

    res.status(201).json({ 
        status: 'success', 
        message: 'Tiquete creado exitosamente',
        data: { ticket: newTicket, ticketNumber: ticketNumber } 
    });

  } catch (error: any) {
    console.error('Error en la creación del tiquete:', error);
    res.status(400).json({ 
        status: 'fail', 
        message: 'Error al procesar la venta. La transacción fue revertida.',
        detail: error.message 
    });
  }
};

// Rutas a exportar
export const ticketRoutes = express.Router();

ticketRoutes.route('/')
    .post(restrictTo(Role.ADMIN, Role.VENTANA, Role.VENDEDOR), createTicket);
