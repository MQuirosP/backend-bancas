/// <reference types="jest" />
import { updateUserSchema } from '../../src/api/v1/validators/user.validator';
import { UserService } from '../../src/domain/user/user.service';
import prisma from '../../src/core/prismaClient';
import UserRepository from '../../src/repositories/user.repository';
import { Role, ActivityType } from '../../src/generated/prisma/client';
import { BackgroundTaskQueue } from '../../src/utils/concurrency';
import ActivityService from '../../src/core/activity.service';
import { CacheService } from '../../src/core/cache.service';

jest.mock('../../src/domain/credit/vendorCredit.service', () => ({
  VendorCreditService: {
    invalidateKeys: jest.fn().mockResolvedValue(undefined),
    handleCreditConfigChanged: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../src/core/prismaClient', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    ventana: {
      findUnique: jest.fn(),
    },
    userBanca: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    $transaction: jest.fn((cb: any) => (typeof cb === 'function' ? cb(prisma) : Promise.all(cb))),
  },
}));

jest.mock('../../src/repositories/user.repository', () => ({
  __esModule: true,
  default: {
    update: jest.fn(),
    findById: jest.fn(),
  },
  UserRepository: {
    update: jest.fn(),
    findById: jest.fn(),
  },
}));

jest.mock('../../src/core/activity.service', () => ({
  __esModule: true,
  default: {
    log: jest.fn().mockResolvedValue(undefined),
  },
  ActivityService: {
    log: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../src/core/cache.service', () => ({
  CacheService: {
    invalidateTag: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    delPattern: jest.fn().mockResolvedValue(undefined),
    wrap: jest.fn(),
  },
}));

describe('Bloque A: Vendor Credit Limit Configuration & Permissions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('1. Zod Validation (updateUserSchema)', () => {
    it('accepts valid credit configuration', () => {
      const parsed = updateUserSchema.safeParse({
        creditLimit: 500000,
        creditAlertThreshold: 85,
        creditBlockMode: true,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.creditLimit).toBe(500000);
        expect(parsed.data.creditAlertThreshold).toBe(85);
        expect(parsed.data.creditBlockMode).toBe(true);
      }
    });

    it('accepts creditLimit as null to remove the limit', () => {
      const parsed = updateUserSchema.safeParse({
        creditLimit: null,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.creditLimit).toBeNull();
      }
    });

    it('accepts creditLimit 0 and transforms it to null to remove the limit', () => {
      const parsedZero = updateUserSchema.safeParse({ creditLimit: 0 });
      expect(parsedZero.success).toBe(true);
      if (parsedZero.success) {
        expect(parsedZero.data.creditLimit).toBeNull();
      }

      const parsedNeg = updateUserSchema.safeParse({ creditLimit: -100 });
      expect(parsedNeg.success).toBe(false);
    });

    it('rejects invalid creditAlertThreshold (< 1 or > 100 or non-integer)', () => {
      expect(updateUserSchema.safeParse({ creditAlertThreshold: 0 }).success).toBe(false);
      expect(updateUserSchema.safeParse({ creditAlertThreshold: 101 }).success).toBe(false);
      expect(updateUserSchema.safeParse({ creditAlertThreshold: 80.5 }).success).toBe(false);
      expect(updateUserSchema.safeParse({ creditAlertThreshold: 1 }).success).toBe(true);
      expect(updateUserSchema.safeParse({ creditAlertThreshold: 100 }).success).toBe(true);
    });

    it('rejects credit fields if role is explicitly passed as non-VENDEDOR', () => {
      const parsedAdmin = updateUserSchema.safeParse({
        role: Role.ADMIN,
        creditLimit: 200000,
      });
      expect(parsedAdmin.success).toBe(false);
      if (!parsedAdmin.success) {
        expect(parsedAdmin.error.issues[0].message).toContain('solo aplican a usuarios con rol VENDEDOR');
      }
    });
  });

  describe('2. Permissions and Hierarchy in UserService.update', () => {
    const vendorId = 'vendedor-uuid-1';
    const ventanaId = 'ventana-uuid-1';
    const otherVentanaId = 'ventana-uuid-2';
    const bancaId = 'banca-uuid-1';

    const baseVendor = {
      id: vendorId,
      name: 'Vendedor Test',
      username: 'vendedor1',
      email: 'vendedor1@test.com',
      role: Role.VENDEDOR,
      ventanaId,
      bancaId,
      code: 'V01',
      creditLimit: 300000,
      creditAlertThreshold: 80,
      creditBlockMode: true,
    };

    it('blocks self-modification of credit limit by VENDEDOR', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(baseVendor);

      await expect(
        UserService.update(
          vendorId,
          { creditLimit: 600000 },
          { id: vendorId, role: Role.VENDEDOR }
        )
      ).rejects.toThrow('No puedes modificar tu propia configuración de crédito');
    });

    it('blocks VENDEDOR from modifying another vendor credit limit', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(baseVendor);

      await expect(
        UserService.update(
          vendorId,
          { creditLimit: 600000 },
          { id: 'another-vendor-id', role: Role.VENDEDOR }
        )
      ).rejects.toThrow('No tienes permisos para modificar límites de crédito');
    });

    it('rejects credit limit update when target user is not a VENDEDOR', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        ...baseVendor,
        role: Role.VENTANA,
      });

      await expect(
        UserService.update(
          vendorId,
          { creditLimit: 600000 },
          { id: 'admin-id', role: Role.ADMIN }
        )
      ).rejects.toThrow('Los topes de crédito solo aplican a usuarios con rol VENDEDOR');
    });

    it('blocks VENTANA from modifying vendor in another ventana', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        ...baseVendor,
        ventanaId: otherVentanaId,
      });
      // actor ventana
      (prisma.user.findUnique as jest.Mock).mockImplementation(({ where }: any) => {
        if (where.id === 'actor-ventana-id') {
          return Promise.resolve({ ventanaId });
        }
        return Promise.resolve({ ...baseVendor, ventanaId: otherVentanaId });
      });

      await expect(
        UserService.update(
          vendorId,
          { creditLimit: 600000 },
          { id: 'actor-ventana-id', role: Role.VENTANA }
        )
      ).rejects.toThrow('No puedes modificar usuarios de otra ventana');
    });

    it('allows VENTANA to update credit configuration of their own vendor', async () => {
      (prisma.user.findUnique as jest.Mock).mockImplementation(({ where }: any) => {
        if (where.id === 'actor-ventana-id') {
          return Promise.resolve({ ventanaId });
        }
        return Promise.resolve(baseVendor);
      });
      (UserRepository.update as jest.Mock).mockResolvedValue({
        ...baseVendor,
        creditLimit: 500000,
        creditAlertThreshold: 90,
      });

      const updated = await UserService.update(
        vendorId,
        { creditLimit: 500000, creditAlertThreshold: 90 },
        { id: 'actor-ventana-id', role: Role.VENTANA }
      );

      expect(UserRepository.update).toHaveBeenCalledWith(
        vendorId,
        expect.objectContaining({
          creditLimit: 500000,
          creditAlertThreshold: 90,
          creditLimitUpdatedAt: expect.any(Date),
          creditLimitUpdatedById: 'actor-ventana-id',
        })
      );
    });

    it('allows ADMIN to update credit configuration of any vendor and enqueues ActivityLog', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(baseVendor);
      (UserRepository.update as jest.Mock).mockResolvedValue({
        ...baseVendor,
        creditLimit: 1000000,
        creditBlockMode: false,
      });

      const enqueueSpy = jest.spyOn(BackgroundTaskQueue, 'enqueue');

      await UserService.update(
        vendorId,
        { creditLimit: 1000000, creditBlockMode: false },
        { id: 'admin-id', role: Role.ADMIN }
      );

      expect(UserRepository.update).toHaveBeenCalledWith(
        vendorId,
        expect.objectContaining({
          creditLimit: 1000000,
          creditBlockMode: false,
          creditLimitUpdatedAt: expect.any(Date),
          creditLimitUpdatedById: 'admin-id',
        })
      );

      expect(enqueueSpy).toHaveBeenCalledWith(
        'ActivityService.logUserCreditLimitUpdate',
        expect.any(Function)
      );

      // Execute background task
      const taskFn = enqueueSpy.mock.calls.find(c => c[0] === 'ActivityService.logUserCreditLimitUpdate')?.[1];
      if (taskFn) {
        await taskFn();
        expect(ActivityService.log).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: 'admin-id',
            action: ActivityType.USER_CREDIT_LIMIT_UPDATE,
            targetId: vendorId,
            details: expect.objectContaining({
              previous: expect.objectContaining({ creditLimit: 300000 }),
              new: expect.objectContaining({ creditLimit: 300000 }), // from mocked result
            }),
          })
        );
      }
    });

    it('allows BANCA to update credit configuration of vendors in their assigned banca', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(baseVendor);
      (prisma.ventana.findUnique as jest.Mock).mockResolvedValue({ bancaId });
      (prisma.userBanca.findFirst as jest.Mock).mockResolvedValue({
        userId: 'actor-banca-id',
        bancaId,
      });
      (UserRepository.update as jest.Mock).mockResolvedValue({
        ...baseVendor,
        creditLimit: 750000,
      });

      await UserService.update(
        vendorId,
        { creditLimit: 750000 },
        { id: 'actor-banca-id', role: Role.BANCA }
      );

      expect(UserRepository.update).toHaveBeenCalledWith(
        vendorId,
        expect.objectContaining({
          creditLimit: 750000,
          creditLimitUpdatedAt: expect.any(Date),
          creditLimitUpdatedById: 'actor-banca-id',
        })
      );
    });

    it('blocks BANCA from updating credit configuration of vendors outside their assigned bancas', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(baseVendor);
      (prisma.ventana.findUnique as jest.Mock).mockResolvedValue({ bancaId: 'other-banca-id' });
      (prisma.userBanca.findFirst as jest.Mock).mockResolvedValue(null); // not assigned

      await expect(
        UserService.update(
          vendorId,
          { creditLimit: 750000 },
          { id: 'actor-banca-id', role: Role.BANCA }
        )
      ).rejects.toThrow('No tienes permiso para modificar este usuario (fuera de tus bancas)');
    });

    it('an update without credit fields does not touch creditLimit or credit audit fields', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(baseVendor);
      (UserRepository.update as jest.Mock).mockResolvedValue({
        ...baseVendor,
        name: 'Vendedor Modificado',
      });

      const enqueueSpy = jest.spyOn(BackgroundTaskQueue, 'enqueue');

      await UserService.update(
        vendorId,
        { name: 'Vendedor Modificado' },
        { id: 'admin-id', role: Role.ADMIN }
      );

      expect(UserRepository.update).toHaveBeenCalledWith(
        vendorId,
        expect.not.objectContaining({
          creditLimitUpdatedAt: expect.any(Date),
          creditLimitUpdatedById: expect.anything(),
        })
      );

      const creditLogEnqueued = enqueueSpy.mock.calls.some(c => c[0] === 'ActivityService.logUserCreditLimitUpdate');
      expect(creditLogEnqueued).toBe(false);
    });

    it('invalidates user cache tag and vendor credit keys when credit configuration changes', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(baseVendor);
      (UserRepository.update as jest.Mock).mockResolvedValue({
        ...baseVendor,
        creditLimit: 750000,
      });

      await UserService.update(
        vendorId,
        { creditLimit: 750000 },
        { id: 'admin-id', role: Role.ADMIN }
      );

      expect(CacheService.invalidateTag).toHaveBeenCalledWith(`user:${vendorId}`);
      expect(CacheService.del).toHaveBeenCalledWith(`auth:session:${vendorId}`);
    });
  });

  describe('3. Mass-assignment and schema strictness on other endpoints', () => {
    it('rejects creditLimit on CreateVendedorSchema (strict)', async () => {
      const { CreateVendedorSchema } = await import('../../src/api/v1/validators/vendedor.validator');
      const parsed = CreateVendedorSchema.safeParse({
        ventanaId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        code: 'V01',
        name: 'Vendedor Test',
        username: 'vendedor1',
        password: 'password123',
        creditLimit: 500000,
      } as any);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((i: any) => i.code === 'unrecognized_keys' || i.message.includes('creditLimit'))).toBe(true);
      }
    });

    it('rejects creditLimit on UpdateVendedorSchema (strict)', async () => {
      const { UpdateVendedorSchema } = await import('../../src/api/v1/validators/vendedor.validator');
      const parsed = UpdateVendedorSchema.safeParse({
        name: 'Nuevo Nombre',
        creditLimit: 500000,
      } as any);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((i: any) => i.code === 'unrecognized_keys' || i.message.includes('creditLimit'))).toBe(true);
      }
    });

    it('rejects creditLimit on createUserSchema (strict)', async () => {
      const { createUserSchema } = await import('../../src/api/v1/validators/user.validator');
      const parsed = createUserSchema.safeParse({
        name: 'Vendedor Nuevo',
        username: 'vendedor_new',
        password: 'password123',
        role: Role.VENDEDOR,
        creditLimit: 500000,
      } as any);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((i: any) => i.code === 'unrecognized_keys' || i.message.includes('creditLimit'))).toBe(true);
      }
    });
  });
});

