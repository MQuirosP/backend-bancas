// Script: Verificar cuántos tickets tienen formato legacy
// Usage: ts-node src/scripts/check-legacy-tickets.ts

import prisma from '../core/prismaClient';
import logger from '../core/logger';

/**
 * Detecta si un ticketNumber es formato legacy (contiene BASE36 y check digit)
 * Formato legacy: TYYMMDD-<BASE36(6)>-<CD2>
 * Formato nuevo: TYYMMDD-XXXXX (5 dígitos decimales)
 */
function isLegacyFormat(ticketNumber: string): boolean {
  // Formato nuevo: TYYMMDD-XXXXX (solo números después del guion)
  const newFormatRegex = /^T\d{6}-\d{5}$/;
  if (newFormatRegex.test(ticketNumber)) {
    return false;
  }
  
  // Formato legacy: TYYMMDD-<BASE36>-<CD2> (contiene letras o tiene 3 partes con guiones)
  const parts = ticketNumber.split('-');
  if (parts.length === 3) {
    // Tiene 3 partes: TYYMMDD, BASE36, CD2
    return true;
  }
  
  // Si tiene letras en la parte después del primer guion, es legacy
  if (parts.length >= 2 && /[A-Z]/.test(parts[1])) {
    return true;
  }
  
  return false;
}

async function main() {
  logger.info({
    layer: 'script',
    action: 'CHECK_LEGACY_TICKETS_START',
    payload: {},
  });

  // Obtener todos los tickets
  const allTickets = await prisma.ticket.findMany({
    select: {
      id: true,
      ticketNumber: true,
      businessDate: true,
      createdAt: true,
      ventanaId: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  logger.info({
    layer: 'script',
    action: 'TOTAL_TICKETS_FOUND',
    payload: { total: allTickets.length },
  });

  // Separar por formato
  const legacyTickets = allTickets.filter((t) => isLegacyFormat(t.ticketNumber));
  const newFormatTickets = allTickets.filter((t) => !isLegacyFormat(t.ticketNumber));
  const withoutBusinessDate = allTickets.filter((t) => !t.businessDate);

  logger.info({
    layer: 'script',
    action: 'CHECK_LEGACY_TICKETS_RESULT',
    payload: {
      total: allTickets.length,
      legacy: legacyTickets.length,
      newFormat: newFormatTickets.length,
      withoutBusinessDate: withoutBusinessDate.length,
      samples: {
        legacy: legacyTickets.slice(0, 5).map((t) => ({
          id: t.id,
          ticketNumber: t.ticketNumber,
          businessDate: t.businessDate,
          createdAt: t.createdAt.toISOString(),
        })),
        newFormat: newFormatTickets.slice(0, 5).map((t) => ({
          id: t.id,
          ticketNumber: t.ticketNumber,
          businessDate: t.businessDate,
          createdAt: t.createdAt.toISOString(),
        })),
      },
    },
  });

  console.log('\n=== RESUMEN ===');
  console.log(`Total de tickets: ${allTickets.length}`);
  console.log(`Tickets con formato legacy: ${legacyTickets.length}`);
  console.log(`Tickets con formato nuevo: ${newFormatTickets.length}`);
  console.log(`Tickets sin businessDate: ${withoutBusinessDate.length}`);
  console.log('\n=== MUESTRAS LEGACY ===');
  legacyTickets.slice(0, 10).forEach((t) => {
    console.log(`- ${t.ticketNumber} (${t.createdAt.toISOString()})`);
  });
}

main().catch((e) => {
  logger.error({
    layer: 'script',
    action: 'CHECK_ERROR',
    meta: { error: (e as Error).message, stack: (e as Error).stack },
  });
  console.error(e);
  process.exit(1);
});

