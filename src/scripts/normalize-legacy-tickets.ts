// Script: Normalizar tickets antiguos de formato legacy a formato moderno
// Usage: ts-node src/scripts/normalize-legacy-tickets.ts [--dry-run]

import prisma from '../core/prismaClient';
import { getBusinessDateCRInfo } from '../utils/businessDate';
import logger from '../core/logger';

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  return { dryRun };
}

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
  const { dryRun } = parseArgs();
  const cutoffHour = process.env.BUSINESS_CUTOFF_HOUR_CR || '06:00';

  logger.info({
    layer: 'script',
    action: 'NORMALIZE_LEGACY_TICKETS_START',
    payload: { dryRun },
  });

  // Obtener todos los tickets con formato legacy
  const allTickets = await prisma.ticket.findMany({
    where: {
      businessDate: null, // Tickets antiguos sin businessDate
    },
    include: {
      sorteo: { select: { scheduledAt: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  // Filtrar solo los que tienen formato legacy
  const legacyTickets = allTickets.filter((t) => isLegacyFormat(t.ticketNumber));

  logger.info({
    layer: 'script',
    action: 'LEGACY_TICKETS_FOUND',
    payload: { total: legacyTickets.length, dryRun },
  });

  if (legacyTickets.length === 0) {
    logger.info({
      layer: 'script',
      action: 'NO_LEGACY_TICKETS',
      payload: { message: 'No se encontraron tickets con formato legacy' },
    });
    return;
  }

  // Agrupar por (ventanaId, businessDate)
  const groups = new Map<string, { key: string; items: typeof legacyTickets }>();
  for (const t of legacyTickets) {
    const bd = getBusinessDateCRInfo({
      scheduledAt: t.sorteo?.scheduledAt ?? null,
      nowUtc: t.createdAt,
      cutoffHour,
    });
    (t as any).__bd = bd;
    const key = `${t.ventanaId}|${bd.businessDateISO}`;
    if (!groups.has(key)) {
      groups.set(key, { key, items: [] as any });
    }
    groups.get(key)!.items.push(t);
  }

  logger.info({
    layer: 'script',
    action: 'GROUPS_CREATED',
    payload: { groups: groups.size },
  });

  // Procesar cada grupo
  for (const [key, group] of groups.entries()) {
    const [ventanaId, dateISO] = key.split('|');
    let seq = 0;

    // Ordenar por createdAt para mantener orden cronológico
    group.items.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    logger.info({
      layer: 'script',
      action: 'GROUP_PROCESSING_START',
      payload: {
        key,
        ventanaId,
        businessDate: dateISO,
        count: group.items.length,
      },
    });

    if (dryRun) {
      logger.info({
        layer: 'script',
        action: 'GROUP_PREVIEW',
        payload: {
          key,
          ventanaId,
          businessDate: dateISO,
          count: group.items.length,
          samples: group.items.slice(0, 3).map((t) => ({
            id: t.id,
            oldNumber: t.ticketNumber,
            newNumber: `T${(t as any).__bd.prefixYYMMDD}-${String(++seq).padStart(5, '0')}`,
          })),
        },
      });
      continue;
    }

    // Verificar el TicketCounter actual para este grupo
    const currentCounter = await prisma.$queryRawUnsafe<{ last: number }[]>(
      `SELECT "last" FROM "TicketCounter" 
       WHERE "businessDate" = $1::date AND "ventanaId" = $2::uuid`,
      dateISO,
      ventanaId
    );
    const currentLast = currentCounter[0]?.last ?? 0;
    
    // Verificar el máximo número de ticket existente para este grupo (incluyendo ya normalizados)
    const existingTickets = await prisma.ticket.findMany({
      where: {
        ventanaId,
        businessDate: dateISO ? new Date(dateISO) : null,
        ticketNumber: {
          startsWith: `T${(group.items[0] as any).__bd.prefixYYMMDD}-`,
        },
      },
      select: { ticketNumber: true },
    });
    
    // Extraer el número secuencial más alto de los tickets existentes
    let maxSeq = currentLast;
    for (const ticket of existingTickets) {
      const match = ticket.ticketNumber.match(/^T\d{6}-(\d{5})$/);
      if (match) {
        const ticketSeq = parseInt(match[1], 10);
        if (ticketSeq > maxSeq) {
          maxSeq = ticketSeq;
        }
      }
    }
    
    logger.info({
      layer: 'script',
      action: 'COUNTER_CHECK',
      payload: {
        key,
        currentCounterLast: currentLast,
        maxExistingSeq: maxSeq,
        existingTicketsCount: existingTickets.length,
      },
    });
    
    // Empezar desde el máximo + 1 para NO colisionar con números existentes
    // Si maxSeq es 0, empezar desde 10 (como sugirió el usuario)
    seq = maxSeq > 0 ? maxSeq : 10;
    
    // Procesar uno por uno en transacciones separadas
    for (const t of group.items) {
      seq += 1;
      const bd = (t as any).__bd as ReturnType<typeof getBusinessDateCRInfo>;
      const seqPadded = String(seq).padStart(5, '0');
      const newNumber = `T${bd.prefixYYMMDD}-${seqPadded}`;

      logger.info({
        layer: 'script',
        action: 'TICKET_NORMALIZE_START',
        payload: {
          ticketId: t.id,
          oldNumber: t.ticketNumber,
          newNumber,
          seq,
        },
      });

      try {
        // Procesar cada ticket en su propia transacción
        await prisma.$transaction(async (tx) => {
          // Verificar que no exista ya (por si acaso)
          const existing = await tx.ticket.findUnique({
            where: { ticketNumber: newNumber },
            select: { id: true },
          });

          if (existing && existing.id !== t.id) {
            throw new Error(`Ticket number ${newNumber} already exists (id: ${existing.id})`);
          }

          // Actualizar ticketNumber y businessDate
          await tx.ticket.update({
            where: { id: t.id },
            data: {
              ticketNumber: newNumber,
              businessDate: bd.businessDate,
            },
          });

          // NO actualizar TicketCounter aquí - se actualizará al final del grupo
          // para evitar sobrescribir valores mientras se procesan otros tickets
        }, {
          timeout: 10000, // 10 segundos por ticket
        });

        logger.info({
          layer: 'script',
          action: 'TICKET_NORMALIZED',
          payload: {
            ticketId: t.id,
            oldNumber: t.ticketNumber,
            newNumber,
            seq,
          },
        });
      } catch (error: any) {
        logger.error({
          layer: 'script',
          action: 'TICKET_NORMALIZE_ERROR',
          payload: {
            ticketId: t.id,
            oldNumber: t.ticketNumber,
            newNumber,
            seq,
            error: error.message,
          },
        });
        // Continuar con el siguiente ticket aunque falle uno
      }
    }
    
    // Actualizar TicketCounter SOLO AL FINAL con el máximo valor asignado
    // Esto previene sobrescribir el contador mientras se procesan tickets
    if (seq > 0) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "TicketCounter" ("businessDate", "ventanaId", "last") 
         VALUES ($1::date, $2::uuid, $3)
         ON CONFLICT ("businessDate", "ventanaId") 
         DO UPDATE SET "last" = GREATEST("TicketCounter"."last", $3)`,
        dateISO,
        ventanaId,
        seq
      );
    }

    logger.info({
      layer: 'script',
      action: 'GROUP_NORMALIZED',
      payload: {
        key,
        ventanaId,
        businessDate: dateISO,
        count: group.items.length,
        lastSeq: seq,
        note: 'TicketCounter updated to max assigned value',
      },
    });
  }

  logger.info({
    layer: 'script',
    action: 'NORMALIZE_LEGACY_TICKETS_DONE',
    payload: {
      totalTickets: legacyTickets.length,
      groups: groups.size,
      dryRun,
    },
  });
}

main().catch((e) => {
  logger.error({
    layer: 'script',
    action: 'NORMALIZE_ERROR',
    meta: { error: (e as Error).message, stack: (e as Error).stack },
  });
  console.error(e);
  process.exit(1);
});

