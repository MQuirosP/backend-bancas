/**
 * TASK: Backfill de tickets para marcar isSorteoClosed en sorteos CLOSED
 *
 * Esta tarea procesa todos los sorteos con status=CLOSED y marca sus tickets
 * con isSorteoClosed=true. Es idempotente y segura para ejecutar múltiples veces.
 *
 * Uso:
 *   npx ts-node src/tools/maintenance/index.ts backfill-sorteo-closed [--dry-run] [--limit=N]
 */

import prisma from "../../../core/prismaClient";
import { info, success, warn, error } from "../utils/logger";

export interface BackfillSorteoClosedOptions {
  dryRun?: boolean;
  limit?: number;  // Límite de sorteos a procesar (para testing)
}

export async function backfillSorteoClosed(opts: BackfillSorteoClosedOptions = {}): Promise<void> {
  const startTime = Date.now();

  info(
    `Iniciando backfill de sorteos CLOSED (dryRun=${opts.dryRun ? "sí" : "no"}, limit=${opts.limit || "ilimitado"})`
  );

  try {
    // 1️⃣ Encontrar sorteos CLOSED
    const closedSorteos = await prisma.sorteo.findMany({
      where: {
        status: 'CLOSED',
        deletedAt: null,  // Solo sorteos no eliminados
      },
      select: {
        id: true,
        name: true,
        loteriaId: true,
      },
      take: opts.limit,
    });

    info(`Encontrados ${closedSorteos.length} sorteos en estado CLOSED`);

    if (closedSorteos.length === 0) {
      success("No hay sorteos CLOSED. Nada que hacer.");
      return;
    }

    let totalTicketsUpdated = 0;

    // 2️⃣ Procesar cada sorteo
    for (let i = 0; i < closedSorteos.length; i++) {
      const sorteo = closedSorteos[i];

      // Encontrar tickets NO marcados
      const ticketsToUpdate = await prisma.ticket.findMany({
        where: {
          sorteoId: sorteo.id,
          isSorteoClosed: false,  // Solo los no marcados
          deletedAt: null,  // Solo activos
        },
        select: { id: true },
      });

      if (ticketsToUpdate.length === 0) {
        continue;
      }

      // Procesar en lotes de 100
      const ticketIds = ticketsToUpdate.map((t) => t.id);
      for (let j = 0; j < ticketIds.length; j += 100) {
        const batch = ticketIds.slice(j, j + 100);

        if (!opts.dryRun) {
          await prisma.ticket.updateMany({
            where: { id: { in: batch } },
            data: { isSorteoClosed: true },
          });
        }

        totalTicketsUpdated += batch.length;
      }

      const progress = `${(i + 1).toString().padStart(5)}/${closedSorteos.length}`;
      const sorteoNameTrunc = sorteo.name.substring(0, 35).padEnd(35);
      info(`[${progress}] ${sorteoNameTrunc} → ${ticketsToUpdate.length} tickets marcados`);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('');
    console.log('════════════════════════════════════════════════════════════════');
    success(`Backfill completado en ${duration}s`);
    console.log(`   Sorteos procesados: ${closedSorteos.length}`);
    console.log(`   Tickets marcados: ${totalTicketsUpdated}`);
    console.log(`   Modo: ${opts.dryRun ? 'DRY RUN (sin cambios)' : 'EJECUTADO'}`);
    console.log('════════════════════════════════════════════════════════════════');
  } catch (err) {
    error(`Error en backfill: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}
