import { Request, Response } from 'express';
import prisma from '../../../core/prismaClient';
import { AppError } from '../../../core/errors';

export const UserBancaController = {
  async list(req: Request, res: Response) {
    const userId = req.params.id;
    if (!userId) throw new AppError('userId is required', 400);

    const userBancas = await prisma.userBanca.findMany({
      where: { userId },
      include: {
        banca: { select: { id: true, name: true, isActive: true } }
      },
      orderBy: [ { isDefault: 'desc' }, { createdAt: 'asc' } ]
    });

    res.json(userBancas);
  },

  async assign(req: Request, res: Response) {
    const userId = req.params.id;
    const { bancaId, isDefault } = req.body;
    
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('User not found', 404);

    const result = await prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.userBanca.updateMany({
          where: { userId },
          data: { isDefault: false }
        });
      }
      return tx.userBanca.upsert({
        where: { userId_bancaId: { userId, bancaId } },
        update: { isDefault: isDefault ?? false },
        create: { userId, bancaId, isDefault: isDefault ?? false },
        include: { banca: { select: { id: true, name: true, isActive: true } } }
      });
    });

    res.status(201).json(result);
  },

  async setDefault(req: Request, res: Response) {
    const userId = req.params.id;
    const { bancaId } = req.params;

    const assignment = await prisma.userBanca.findUnique({
      where: { userId_bancaId: { userId, bancaId } }
    });
    if (!assignment) throw new AppError('Asignación no encontrada', 404);

    await prisma.$transaction(async (tx) => {
      // Remover isDefault de todas las demás
      await tx.userBanca.updateMany({
        where: { userId },
        data: { isDefault: false }
      });
      // Asignar isDefault a la elegida
      await tx.userBanca.update({
        where: { userId_bancaId: { userId, bancaId } },
        data: { isDefault: true }
      });
      // Sincronizar el perfil del usuario (Side-Effect opcional)
      await tx.user.update({
        where: { id: userId },
        data: { bancaId }
      });
    });

    res.json({ message: 'Banca predeterminada actualizada exitosamente' });
  },

  async remove(req: Request, res: Response) {
    const userId = req.params.id;
    const { bancaId } = req.params;

    const assignment = await prisma.userBanca.findUnique({
      where: { userId_bancaId: { userId, bancaId } }
    });

    if (!assignment) throw new AppError('Asignación no encontrada', 404);

    if (assignment.isDefault) {
      throw new AppError('No puedes eliminar la banca principal del usuario. Asigna otra banca como principal primero.', 400, 'CANNOT_DELETE_DEFAULT');
    }

    await prisma.userBanca.delete({
      where: { userId_bancaId: { userId, bancaId } }
    });

    res.json({ message: 'Banca removida exitosamente' });
  }
};

export default UserBancaController;
