// tests/helpers/domainFixtures.ts
import prisma from '../../../src/core/prismaClient'; // Ensure this file exists at ../../src/core/prismaClient.ts or .js

// If the file does not exist, create it with the following content:
// import { PrismaClient } from '@prisma/client';
// const prisma = new PrismaClient();
// export default prisma;
import { SorteoStatus } from '@prisma/client';

export async function ensureBanca(id = 'banca-test') {
  return prisma.banca.upsert({
    where: { id },
    update: {},
    create: { id, code: 'B001', name: 'Banca Test', isActive: true },
  });
}

export async function ensureLoteria(id = 'test-loteria') {
  return prisma.loteria.upsert({
    where: { id },
    update: {},
    create: { id, name: 'Lotería Test', isActive: true },
  });
}

export async function ensureVentana(id = 'test-ventana', bancaId = 'banca-test') {
  return prisma.ventana.upsert({
    where: { id },
    update: {},
    create: {
      id,
      code: 'V001',
      name: 'Ventana Test',
      bancaId,
      commissionMarginX: 0.1, // requerido en tu schema
      isActive: true,
    },
  });
}

export async function ensureSorteo(id = 'test-sorteo', loteriaId = 'test-loteria') {
  return prisma.sorteo.upsert({
    where: { id },
    update: {},
    create: {
      id,
      name: 'Sorteo Tarde',
      loteriaId,
      scheduledAt: new Date('2025-10-07T15:00:00Z'),
      status: SorteoStatus.SCHEDULED,
    },
  });
}

export async function ensureLoteriaMultiplier(
  id = 'test-multiplier',
  loteriaId = 'test-loteria',
) {
  return prisma.loteriaMultiplier.upsert({
    where: { id },
    update: {},
    create: { id, name: 'x2', valueX: 2, loteriaId, isActive: true },
  });
}

export async function seedCore({
  bancaId = 'banca-test',
  ventanaId = 'test-ventana',
  loteriaId = 'test-loteria',
  sorteoId = 'test-sorteo',
  multiplierId = 'test-multiplier',
} = {}) {
  await ensureBanca(bancaId);
  await ensureLoteria(loteriaId);
  await ensureVentana(ventanaId, bancaId);
  await ensureSorteo(sorteoId, loteriaId);
  await ensureLoteriaMultiplier(multiplierId, loteriaId);
}
