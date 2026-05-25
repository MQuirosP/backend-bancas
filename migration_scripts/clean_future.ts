import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function cleanFutureSorteos() {
  console.log('Buscando sorteos futuros a partir del 26 de mayo de 2026...');
  
  // 26 de mayo 00:00 hora Costa Rica (UTC-6) -> 06:00 UTC
  const targetDate = new Date('2026-05-26T06:00:00.000Z');
  
  try {
    const result = await prisma.sorteo.deleteMany({
      where: {
        scheduledAt: {
          gte: targetDate
        }
      }
    });
    
    console.log('✅ Eliminación exitosa.');
    console.log('Sorteos eliminados:', result.count);
  } catch (error: any) {
    console.error('Error al eliminar sorteos futuros:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

cleanFutureSorteos();
