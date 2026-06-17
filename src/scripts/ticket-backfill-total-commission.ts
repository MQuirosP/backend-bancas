// Script: Backfill totalCommission para tickets existentes
// Usage: npx dotenv-cli -e .env.local -- ts-node src/scripts/ticket-backfill-total-commission.ts [--dry-run] [--batch-size N]

import prisma from '../core/prismaClient';
import logger from '../core/logger';
import { Prisma } from '../generated/prisma/client';

function parseArgs() {
  const args = process.argv.slice(2);
  const out: { dryRun?: boolean; batchSize?: number } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') out.dryRun = true;
    else if (args[i] === '--batch-size' && i + 1 < args.length) {
      out.batchSize = parseInt(args[++i], 10);
    }
  }
  return {
    dryRun: out.dryRun ?? false,
    batchSize: out.batchSize ?? 100,
  };
}

async function main() {
  const { dryRun, batchSize } = parseArgs();

  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  BACKFILL: totalCommission para Tickets                  ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  if (dryRun) {
    console.log('⚠️  MODO DRY-RUN: No se realizarán cambios en la base de datos\n');
  }

  try {
    // 1. Primero verificar que la columna existe, si no, crearla
    try {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "totalCommission" DOUBLE PRECISION DEFAULT 0;`
      );
      console.log('✅ Columna totalCommission verificada/creada\n');
    } catch (error: any) {
      console.log(`⚠️  Advertencia al verificar columna: ${error.message}\n`);
    }

    // 2. Contar tickets usando SQL raw para evitar problemas con Prisma Client
    const totalCountResult = await prisma.$queryRaw<Array<{ count: bigint }>>(
      Prisma.sql`SELECT COUNT(*)::bigint as count FROM "Ticket" WHERE "deletedAt" IS NULL`
    );
    const totalTickets = Number(totalCountResult[0]?.count) || 0;

    console.log(`📊 Total de tickets a revisar: ${totalTickets}\n`);

    if (totalTickets === 0) {
      console.log('✅ No hay tickets para procesar');
      return;
    }

    // 3. Obtener tickets en lotes usando SQL raw
    let processed = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    let offset = 0;
    while (offset < totalTickets) {
      const ticketsResult = await prisma.$queryRaw<Array<{
        id: string;
        ticketNumber: string;
        totalCommission: number | null;
      }>>(
        Prisma.sql`
          SELECT t.id, t."ticketNumber", t."totalCommission"
          FROM "Ticket" t
          WHERE t."deletedAt" IS NULL
          ORDER BY t."createdAt" ASC
          LIMIT ${batchSize}
          OFFSET ${offset}
        `
      );

      if (ticketsResult.length === 0) break;

      const jugadasResult = await prisma.$queryRaw<Array<{
        ticketId: string;
        totalCommission: number;
      }>>(
        Prisma.sql`
          SELECT 
            j."ticketId",
            COALESCE(SUM(j."commissionAmount"), 0)::DOUBLE PRECISION as "totalCommission"
          FROM "Jugada" j
          WHERE j."deletedAt" IS NULL
            AND j."ticketId" IN (${Prisma.join(ticketsResult.map(t => Prisma.sql`${t.id}::uuid`))})
          GROUP BY j."ticketId"
        `
      );

      const jugadasMap = new Map(
        jugadasResult.map(j => [j.ticketId, j.totalCommission])
      );

      const tickets = ticketsResult.map(t => ({
        id: t.id,
        ticketNumber: t.ticketNumber,
        totalCommission: t.totalCommission ?? 0,
        calculatedCommission: jugadasMap.get(t.id) ?? 0,
      }));

      // 4. Procesar cada ticket
      for (const ticket of tickets) {
        try {
          // Calcular totalCommission ya está calculado en calculatedCommission
          const calculatedTotalCommission = ticket.calculatedCommission;

          // Verificar si necesita actualización
          const currentTotalCommission = ticket.totalCommission ?? 0;
          const needsUpdate = Math.abs(currentTotalCommission - calculatedTotalCommission) > 0.01; // Tolerancia para decimales

          if (needsUpdate) {
            if (dryRun) {
              console.log(
                `[DRY-RUN] Ticket ${ticket.ticketNumber} (${ticket.id}): ` +
                  `actual: ${currentTotalCommission}, calculado: ${calculatedTotalCommission.toFixed(2)}`
              );
              updated++;
            } else {
              // Actualizar en transacción usando SQL raw
              await prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(
                  `UPDATE "Ticket" SET "totalCommission" = $1 WHERE id = $2::uuid`,
                  calculatedTotalCommission,
                  ticket.id
                );

                // Log de actividad
                await tx.activityLog.create({
                  data: {
                    userId: null,
                    action: 'SYSTEM_ACTION',
                    targetType: 'TICKET',
                    targetId: ticket.id,
                    details: {
                      op: 'TICKET_BACKFILL_TOTAL_COMMISSION',
                      ticketNumber: ticket.ticketNumber,
                      from: currentTotalCommission,
                      to: calculatedTotalCommission,
                    },
                  },
                });
              });

              logger.info({
                layer: 'script',
                action: 'TICKET_UPDATED',
                payload: {
                  ticketId: ticket.id,
                  ticketNumber: ticket.ticketNumber,
                  from: currentTotalCommission,
                  to: calculatedTotalCommission,
                },
              });

              updated++;
            }
          } else {
            skipped++;
          }

          processed++;
        } catch (error: any) {
          errors++;
          logger.error({
            layer: 'script',
            action: 'TICKET_UPDATE_ERROR',
            payload: {
              ticketId: ticket.id,
              ticketNumber: ticket.ticketNumber,
              error: error.message,
            },
          });

          console.error(`❌ Error procesando ticket ${ticket.ticketNumber}: ${error.message}`);
        }
      }

      // 4. Mostrar progreso
      const progress = ((processed / totalTickets) * 100).toFixed(1);
      console.log(
        `📈 Progreso: ${processed}/${totalTickets} (${progress}%) - ` +
          `Actualizados: ${updated}, Omitidos: ${skipped}, Errores: ${errors}`
      );

      offset += batchSize;
    }

    // 5. Resumen final
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║  RESUMEN FINAL                                          ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    console.log(`✅ Tickets procesados: ${processed}`);
    console.log(`🔄 Tickets actualizados: ${updated}`);
    console.log(`⏭️  Tickets omitidos (ya correctos): ${skipped}`);
    console.log(`❌ Errores: ${errors}`);

    if (dryRun) {
      console.log('\n⚠️  Este fue un DRY-RUN. Para aplicar los cambios, ejecuta sin --dry-run');
    } else {
      console.log('\n✅ Backfill completado exitosamente');
    }

    logger.info({
      layer: 'script',
      action: 'BACKFILL_COMPLETE',
      payload: {
        processed,
        updated,
        skipped,
        errors,
        dryRun,
      },
    });
  } catch (error: any) {
    console.error('\n❌ Error fatal en el backfill:', error);
    logger.error({
      layer: 'script',
      action: 'BACKFILL_ERROR',
      payload: {
        error: error.message,
        stack: error.stack,
      },
    });
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

