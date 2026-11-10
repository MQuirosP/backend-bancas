import { Prisma } from "../../../generated/prisma/client";
import prisma from "../../../core/prismaClient";
import { info, success, warn } from "../utils/logger";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface PurgeProgressInfo {
  batchIndex: number;
  totalBatches: number;
  deletedTickets: number;
  deletedJugadas: number;
  deletedPayments: number;
  totalTickets: number;
}

export interface PurgeTicketsParams {
  /**
   * Fecha LÍMITE inclusiva en formato YYYY-MM-DD (zona horaria Costa Rica).
   * Se eliminarán todos los tickets cuyo businessDate (o createdAt convertido a CR)
   * sea menor o igual a este valor.
   */
  beforeDate: string;
  dryRun?: boolean;
  batchSize?: number;
  sleepMs?: number;
  onProgress?: (progress: PurgeProgressInfo) => void;
}

export interface PurgeSummaryResult {
  identified: number;
  identifiedJugadas: number;
  identifiedPayments: number;
  minDate: string | null;
  maxDate: string | null;
  deletedTickets: number;
  deletedJugadas: number;
  deletedPayments: number;
  deletedCounters: number;
  dryRun: boolean;
  batchSize: number;
  totalBatches: number;
}

interface DryRunSummaryRow {
  tickets_identified: bigint;
  jugadas_identified: bigint;
  payments_identified: bigint;
  min_date: string | null;
  max_date: string | null;
}

interface BatchDeleteRow {
  tickets_deleted: bigint;
  jugadas_deleted: bigint;
  payments_deleted: bigint;
}

function assertIsoDate(input: string): void {
  if (!ISO_DATE.test(input)) {
    throw new Error(`La fecha debe tener formato YYYY-MM-DD (recibido: ${input})`);
  }
}

export async function purgeTickets({
  beforeDate,
  dryRun = false,
  batchSize = 2500,
  sleepMs = 100,
  onProgress,
}: PurgeTicketsParams): Promise<PurgeSummaryResult> {
  assertIsoDate(beforeDate);

  info(`Auditoría de tickets con fecha <= ${beforeDate} (dryRun=${dryRun}, batchSize=${batchSize})`);

  // 1. Identificación y conteo exacto de registros afectados usando índice sobre businessDate
  const summaryRows = await prisma.$queryRaw<DryRunSummaryRow[]>(
    Prisma.sql`
      WITH target_tickets AS (
        SELECT
          t.id,
          COALESCE(
            t."businessDate",
            (t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')::date
          ) AS effective_date
        FROM "Ticket" t
        WHERE (
          t."businessDate" <= ${beforeDate}::date
          OR (
            t."businessDate" IS NULL
            AND (t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')::date <= ${beforeDate}::date
          )
        )
      )
      SELECT
        (SELECT COUNT(*)::bigint FROM target_tickets) AS tickets_identified,
        (
          SELECT COUNT(j.id)::bigint
          FROM "Jugada" j
          WHERE j."ticketId" IN (SELECT id FROM target_tickets)
        ) AS jugadas_identified,
        (
          SELECT COUNT(tp.id)::bigint
          FROM "TicketPayment" tp
          WHERE tp."ticketId" IN (SELECT id FROM target_tickets)
        ) AS payments_identified,
        (SELECT MIN(effective_date)::text FROM target_tickets) AS min_date,
        (SELECT MAX(effective_date)::text FROM target_tickets) AS max_date;
    `
  );

  const summary = summaryRows[0];
  const identifiedTickets = Number(summary?.tickets_identified ?? BigInt(0));
  const identifiedJugadas = Number(summary?.jugadas_identified ?? BigInt(0));
  const identifiedPayments = Number(summary?.payments_identified ?? BigInt(0));
  const minDate = summary?.min_date ?? null;
  const maxDate = summary?.max_date ?? null;
  const totalBatches = Math.ceil(identifiedTickets / batchSize);

  if (identifiedTickets === 0) {
    warn("No se encontraron tickets para eliminar en el rango especificado.");
    return {
      identified: 0,
      identifiedJugadas: 0,
      identifiedPayments: 0,
      minDate: null,
      maxDate: null,
      deletedTickets: 0,
      deletedJugadas: 0,
      deletedPayments: 0,
      deletedCounters: 0,
      dryRun,
      batchSize,
      totalBatches: 0,
    };
  }

  info(`Tickets identificados: ${identifiedTickets.toLocaleString()}`);
  info(`Jugadas identificadas: ${identifiedJugadas.toLocaleString()}`);
  info(`Pagos identificados: ${identifiedPayments.toLocaleString()}`);
  info(`Rango detectado: ${minDate} a ${maxDate}`);

  if (dryRun) {
    warn("Modo dryRun activado: no se eliminará ningún registro de la base de datos.");
    return {
      identified: identifiedTickets,
      identifiedJugadas,
      identifiedPayments,
      minDate,
      maxDate,
      deletedTickets: 0,
      deletedJugadas: 0,
      deletedPayments: 0,
      deletedCounters: 0,
      dryRun: true,
      batchSize,
      totalBatches,
    };
  }

  // 2. Ejecución real por lotes (Batch Chunking) para no saturar WAL ni locks en producción
  const beforeDateUtc = new Date(`${beforeDate}T00:00:00.000Z`);
  let totalDeletedTickets = 0;
  let totalDeletedJugadas = 0;
  let totalDeletedPayments = 0;
  let currentBatchIndex = 0;

  info(`Iniciando purga en ${totalBatches} lote(s) de ${batchSize} tickets con pausas de ${sleepMs}ms...`);

  while (true) {
    currentBatchIndex++;

    // Transacción atómica corta por lote
    const batchResult = await prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<BatchDeleteRow[]>(
          Prisma.sql`
            WITH target_tickets AS (
              SELECT t.id
              FROM "Ticket" t
              WHERE (
                t."businessDate" <= ${beforeDate}::date
                OR (
                  t."businessDate" IS NULL
                  AND (t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')::date <= ${beforeDate}::date
                )
              )
              LIMIT ${batchSize}
            ),
            deleted_payments AS (
              DELETE FROM "TicketPayment" tp
              USING target_tickets tt
              WHERE tp."ticketId" = tt.id
              RETURNING tp.id
            ),
            deleted_jugadas AS (
              DELETE FROM "Jugada" j
              USING target_tickets tt
              WHERE j."ticketId" = tt.id
              RETURNING j.id
            ),
            deleted_tickets AS (
              DELETE FROM "Ticket" t
              USING target_tickets tt
              WHERE t.id = tt.id
              RETURNING t.id
            )
            SELECT
              (SELECT COUNT(*)::bigint FROM deleted_tickets) AS tickets_deleted,
              (SELECT COUNT(*)::bigint FROM deleted_jugadas) AS jugadas_deleted,
              (SELECT COUNT(*)::bigint FROM deleted_payments) AS payments_deleted;
          `
        );
        return rows[0];
      },
      {
        timeout: 30000,
      }
    );

    const batchTickets = Number(batchResult?.tickets_deleted ?? 0);
    const batchJugadas = Number(batchResult?.jugadas_deleted ?? 0);
    const batchPayments = Number(batchResult?.payments_deleted ?? 0);

    if (batchTickets === 0) {
      // No hay más tickets por borrar
      break;
    }

    totalDeletedTickets += batchTickets;
    totalDeletedJugadas += batchJugadas;
    totalDeletedPayments += batchPayments;

    if (onProgress) {
      onProgress({
        batchIndex: currentBatchIndex,
        totalBatches: Math.max(totalBatches, currentBatchIndex),
        deletedTickets: totalDeletedTickets,
        deletedJugadas: totalDeletedJugadas,
        deletedPayments: totalDeletedPayments,
        totalTickets: identifiedTickets,
      });
    }

    // Pausa breve entre lotes para despresurizar el motor y permitir transacciones concurrentes
    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }

  // 3. Limpieza de TicketCounter para las fechas purgadas
  const counters = await prisma.ticketCounter.deleteMany({
    where: {
      businessDate: {
        lte: beforeDateUtc,
      },
    },
  });

  success(
    `Purga finalizada: Eliminados ${totalDeletedTickets.toLocaleString()} tickets, ${totalDeletedJugadas.toLocaleString()} jugadas, ${totalDeletedPayments.toLocaleString()} pagos y ${counters.count} registros de TicketCounter.`
  );

  return {
    identified: identifiedTickets,
    identifiedJugadas,
    identifiedPayments,
    minDate,
    maxDate,
    deletedTickets: totalDeletedTickets,
    deletedJugadas: totalDeletedJugadas,
    deletedPayments: totalDeletedPayments,
    deletedCounters: counters.count,
    dryRun: false,
    batchSize,
    totalBatches: currentBatchIndex,
  };
}
