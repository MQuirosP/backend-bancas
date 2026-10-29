import UserService from '../../src/domain/user/user.service';
import prisma from '../../src/core/prismaClient';
import { Role, ActivityType } from '../../src/generated/prisma/client';
import { AppError } from '../../src/core/errors';
import ActivityService from '../../src/core/activity.service';

jest.mock('../../src/core/prismaClient', () => ({
  user: {
    findUnique: jest.fn(),
  },
  userBanca: {
    findMany: jest.fn(),
  },
}));

jest.mock('../../src/core/activity.service', () => ({
  log: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/core/cache.service', () => ({
  CacheService: {
    del: jest.fn().mockResolvedValue(undefined),
    invalidateTag: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockDeleteAllVendorKeys = jest.fn().mockResolvedValue({
  deletedCount: 4,
  deletedKeys: [
    'vendedor:v-1:credit:cfg',
    'vendedor:v-1:credit:base',
    'vendedor:v-1:credit:open_by_sorteo',
    'auth:session:v-1',
  ],
});

jest.mock('../../src/domain/cache/redisOps.service', () => ({
  RedisOpsService: {
    deleteAllVendorKeys: (...args: any[]) => mockDeleteAllVendorKeys(...args),
    deleteAllUserKeys: jest.fn().mockResolvedValue({ deletedCount: 1, deletedKeys: [] }),
    deleteAllVentanaKeys: jest.fn().mockResolvedValue({ deletedCount: 2, deletedKeys: [] }),
    deleteAllBancaKeys: jest.fn().mockResolvedValue({ deletedCount: 3, deletedKeys: [] }),
    deleteKeys: jest.fn().mockResolvedValue({ deletedCount: 1, deletedKeys: [] }),
  },
}));

const mockUpdateBaseBalance = jest.fn().mockResolvedValue(undefined);
const mockGetVendorsCreditStatus = jest.fn().mockResolvedValue({
  enabled: true,
  items: [
    {
      vendedorId: 'v-1',
      creditLimit: 200000,
      effectiveBalance: 169000,
      percentageUsed: 84.5,
      status: 'NORMAL',
      updatedAt: '2026-10-28T19:00:00.000Z',
    },
  ],
});

jest.mock('../../src/domain/credit/vendorCredit.service', () => ({
  VendorCreditService: {
    updateBaseBalance: (...args: any[]) => mockUpdateBaseBalance(...args),
    getVendorsCreditStatus: (...args: any[]) => mockGetVendorsCreditStatus(...args),
  },
}));

describe('UserService.clearCache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('permite a un ADMIN limpiar la caché de un vendedor y sincronizar su crédito', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'v-1',
      name: 'Vendedor 1',
      username: 'tiemposgold1',
      role: Role.VENDEDOR,
      bancaId: 'banca-1',
      ventanaId: 'ventana-1',
      ventana: { bancaId: 'banca-1' },
    });

    const result = await UserService.clearCache('v-1', {
      id: 'admin-1',
      role: Role.ADMIN,
    });

    expect(result.userId).toBe('v-1');
    expect(result.username).toBe('tiemposgold1');
    expect(result.deletedCount).toBe(4);
    expect(mockDeleteAllVendorKeys).toHaveBeenCalledWith('v-1');
    expect(mockUpdateBaseBalance).toHaveBeenCalledWith('v-1');
    expect(result.creditStatus).toEqual(
      expect.objectContaining({
        vendedorId: 'v-1',
        effectiveBalance: 169000,
        status: 'NORMAL',
      })
    );
    expect(ActivityService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin-1',
        action: ActivityType.USER_UPDATE,
        targetType: 'USER',
        targetId: 'v-1',
      })
    );
  });

  it('permite a una BANCA limpiar la caché de un vendedor de su misma banca', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'v-1',
      name: 'Vendedor 1',
      username: 'tiemposgold1',
      role: Role.VENDEDOR,
      bancaId: 'banca-jj',
      ventanaId: 'ventana-1',
      ventana: { bancaId: 'banca-jj' },
    });

    (prisma.userBanca.findMany as jest.Mock).mockResolvedValueOnce([
      { bancaId: 'banca-jj' },
    ]);

    const result = await UserService.clearCache('v-1', {
      id: 'banca-user-1',
      role: Role.BANCA,
      bancaId: 'banca-jj',
    });

    expect(result.userId).toBe('v-1');
    expect(mockDeleteAllVendorKeys).toHaveBeenCalledWith('v-1');
    expect(mockUpdateBaseBalance).toHaveBeenCalledWith('v-1');
  });

  it('rechaza con 403 a una BANCA intentando limpiar la caché de un vendedor de otra banca', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'v-2',
      name: 'Vendedor Ajeno',
      username: 'vendedor2',
      role: Role.VENDEDOR,
      bancaId: 'otra-banca',
      ventanaId: 'ventana-2',
      ventana: { bancaId: 'otra-banca' },
    });

    (prisma.userBanca.findMany as jest.Mock).mockResolvedValueOnce([
      { bancaId: 'mi-banca' },
    ]);

    await expect(
      UserService.clearCache('v-2', {
        id: 'banca-user-1',
        role: Role.BANCA,
        bancaId: 'mi-banca',
      })
    ).rejects.toThrow(new AppError('No tienes permiso para gestionar usuarios fuera de tu banca', 403, 'FORBIDDEN'));

    expect(mockDeleteAllVendorKeys).not.toHaveBeenCalled();
  });

  it('rechaza con 403 a roles no autorizados (VENTANA o VENDEDOR)', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'v-1',
      name: 'Vendedor 1',
      username: 'tiemposgold1',
      role: Role.VENDEDOR,
      bancaId: 'banca-1',
      ventanaId: 'ventana-1',
      ventana: { bancaId: 'banca-1' },
    });

    await expect(
      UserService.clearCache('v-1', {
        id: 'ventana-user-1',
        role: Role.VENTANA,
      })
    ).rejects.toThrow(new AppError('Solo usuarios con rol ADMIN o BANCA pueden limpiar la caché', 403, 'FORBIDDEN'));
  });

  it('retorna 404 si el usuario objetivo no existe', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);

    await expect(
      UserService.clearCache('no-existe', {
        id: 'admin-1',
        role: Role.ADMIN,
      })
    ).rejects.toThrow(new AppError('Usuario no encontrado', 404, 'USER_NOT_FOUND'));
  });
});

