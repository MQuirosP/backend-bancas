// Script: Backfill businessDate (CR) and renumber tickets per (businessDate, ventana)
// Usage: ts-node src/scripts/ticket-backfill-business-date.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--cutoff HH:mm]

import prisma from '../core/prismaClient';
import { getBusinessDateCRInfo } from '../utils/businessDate';
import logger from '../core/logger';

function parseArgs() {
  const args = process.argv.slice(2);
  const out: { from?: string; to?: string; cutoff?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from') out.from = args[++i];
    else if (args[i] === '--to') out.to = args[++i];
    else if (args[i] === '--cutoff') out.cutoff = args[++i];
  }
  return out;
}

async function main() {
  const { from, to, cutoff } = parseArgs();
  const cutoffHour = cutoff || process.env.BUSINESS_CUTOFF_HOUR_CR || '06:00';
  const where: any = {};
  if (from || to) {
    where.createdAt = {} as any;
    if (from) (where.createdAt as any).gte = new Date(from + 'T00:00:00Z');
    if (to) (where.createdAt as any).lte = new Date(to + 'T23:59:59Z');
  }

  const tickets = await prisma.ticket.findMany({
    where,
    include: { sorteo: { select: { scheduledAt: true } } },
    orderBy: { createdAt: 'asc' },
  });

  // Group by ventanaId + computed businessDate
  const groups = new Map<string, { key: string; items: typeof tickets }>();
  for (const t of tickets) {
    const bd = getBusinessDateCRInfo({ scheduledAt: t.sorteo?.scheduledAt ?? null, nowUtc: t.createdAt, cutoffHour });
    (t as any).__bd = bd; // annotate
    const key = `${t.ventanaId}|${bd.businessDateISO}`;
    if (!groups.has(key)) groups.set(key, { key, items: [] as any });
    groups.get(key)!.items.push(t);
  }

  for (const [key, group] of groups.entries()) {
    // Re-number sequentially per group
    let seq = 0;
    await prisma.$transaction(async (tx) => {
      const [ventanaId, dateISO] = key.split('|');
      for (const t of group.items) {
        seq += 1;
        const bd = (t as any).__bd as ReturnType<typeof getBusinessDateCRInfo>;
        const seqPadded = String(seq).padStart(5, '0');
        const newNumber = `T${bd.prefixYYMMDD}-${seqPadded}`;

        // Update ticketNumber and businessDate
        await tx.$executeRawUnsafe(
          `UPDATE "Ticket" SET "ticketNumber" = $1, "businessDate" = $2::date WHERE id = $3::uuid`,
          newNumber,
          bd.businessDateISO,
          t.id
        );

        // Log activity
        await tx.activityLog.create({
          data: {
            userId: null,
            action: 'SYSTEM_ACTION',
            targetType: 'TICKET',
            targetId: t.id,
            details: {
              op: 'TICKET_RENUMBER',
              fromNumber: t.ticketNumber,
              toNumber: newNumber,
              businessDate: bd.businessDateISO,
              ventanaId,
            },
          },
        });
      }

      // Update TicketCounter last for this group
      await tx.$executeRawUnsafe(
        `INSERT INTO "TicketCounter" ("businessDate", "ventanaId", "last") VALUES ($1::date, $2::uuid, $3)
         ON CONFLICT ("businessDate", "ventanaId") DO UPDATE SET "last" = $3`,
        group.items[0] ? (group.items[0] as any).__bd.businessDateISO : null,
        group.items[0]?.ventanaId ?? null,
        seq
      );
    });

    logger.info({ layer: 'script', action: 'GROUP_PROCESSED', payload: { key, count: group.items.length, last: seq } });
  }

  logger.info({ layer: 'script', action: 'DONE', payload: { groups: groups.size, tickets: tickets.length } });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

