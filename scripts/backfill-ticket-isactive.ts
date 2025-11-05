// scripts/backfill-ticket-isactive.ts
import prisma from '../src/core/prismaClient';
import logger from '../src/core/logger';

async function backfillTicketIsActive() {
  try {
    logger.info({
      layer: 'script',
      action: 'BACKFILL_TICKET_ISACTIVE_START',
      payload: { message: 'Starting backfill for Ticket.isActive' },
    });

    // Actualizar todos los tickets que no tienen isActive = true
    const result = await prisma.ticket.updateMany({
      where: {
        isActive: { not: true },
      },
      data: {
        isActive: true,
      },
    });

    logger.info({
      layer: 'script',
      action: 'BACKFILL_TICKET_ISACTIVE_COMPLETE',
      payload: {
        updatedCount: result.count,
        message: 'Backfill completed successfully',
      },
    });

    console.log(`✅ Backfill completed: ${result.count} tickets updated`);
  } catch (error: any) {
    logger.error({
      layer: 'script',
      action: 'BACKFILL_TICKET_ISACTIVE_ERROR',
      payload: {
        message: error.message,
        stack: error.stack,
      },
    });

    console.error('❌ Error during backfill:', error.message);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

backfillTicketIsActive();

