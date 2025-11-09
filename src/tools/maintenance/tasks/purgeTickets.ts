import { Prisma } from "@prisma/client";
import prisma from "../../../core/prismaClient";
import { info, success, warn } from "../utils/logger";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface PurgeTicketsParams {
  /**
   * Fecha LÍMITE inclusiva en formato YYYY-MM-DD (zona horaria Costa Rica).
   * Se eliminarán todos los tickets cuyo businessDate (o createdAt convertido a CR)
   * sea menor o igual a este valor.
   */
  beforeDate: string;
  dryRun?: boolean;
}

interface PurgeSummaryRow {
  tickets_identified: bigint;
  tickets_deleted: bigint | null;
  jugadas_deleted: bigint | null;
  payments_deleted: bigint | null;
}

function assertIsoDate(input: string): void {
  if (!ISO_DATE.test(input)) {
    throw new Error(`La fecha debe tener formato YYYY-MM-DD (recibido: ${input})`);
  }
}

export async function purgeTickets({ beforeDate, dryRun = false }: PurgeTicketsParams) {
  assertIsoDate(beforeDate);

  info(`Identificando tickets con fecha <= ${beforeDate} (dryRun=${dryRun})`);

  const summary = await prisma.$queryRaw<PurgeSummaryRow[]>(
    Prisma.sql`
      WITH target_tickets AS (
        SELECT t.id
        FROM "Ticket" t
        WHERE COALESCE(
          t."businessDate",
          (t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')
        )::date <= ${beforeDate}::date
      )
      SELECT
        (SELECT COUNT(*)::bigint FROM target_tickets) AS tickets_identified,
        NULL::bigint AS tickets_deleted,
        NULL::bigint AS jugadas_deleted,
        NULL::bigint AS payments_deleted
    `
  );

  const identified = summary[0]?.tickets_identified ?? BigInt(0);

  if (identified === BigInt(0)) {
    warn("No se encontraron tickets para eliminar.");
    return {
      identified: 0,
      deletedTickets: 0,
      deletedJugadas: 0,
      deletedPayments: 0,
      deletedCounters: 0,
      dryRun,
    };
  }

  info(`Tickets identificados: ${identified.toString()}`);

  if (dryRun) {
    warn("dryRun habilitado: no se eliminarán registros.");
    return {
      identified: Number(identified),
      deletedTickets: 0,
      deletedJugadas: 0,
      deletedPayments: 0,
      deletedCounters: 0,
      dryRun,
    };
  }

  const beforeDateUtc = new Date(`${beforeDate}T00:00:00.000Z`);

  const [deleteResults, counters] = await prisma.$transaction([
    prisma.$queryRaw<PurgeSummaryRow[]>(
      Prisma.sql`
        WITH target_tickets AS (
          SELECT t.id
          FROM "Ticket" t
          WHERE COALESCE(
            t."businessDate",
            (t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')
          )::date <= ${beforeDate}::date
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
          (SELECT COUNT(*)::bigint FROM target_tickets) AS tickets_identified,
          (SELECT COUNT(*)::bigint FROM deleted_tickets) AS tickets_deleted,
          (SELECT COUNT(*)::bigint FROM deleted_jugadas) AS jugadas_deleted,
          (SELECT COUNT(*)::bigint FROM deleted_payments) AS payments_deleted
      `
    ),
    prisma.ticketCounter.deleteMany({
      where: {
        businessDate: {
          lte: beforeDateUtc,
        },
      },
    }),
  ]);

  const deletionSummary = deleteResults[0]!;
  const deletedTickets = Number(deletionSummary.tickets_deleted ?? BigInt(0));
  const deletedJugadas = Number(deletionSummary.jugadas_deleted ?? BigInt(0));
  const deletedPayments = Number(deletionSummary.payments_deleted ?? BigInt(0));
  const deletedCounters = counters.count;

  success(
    `Eliminados ${deletedTickets} tickets, ${deletedJugadas} jugadas, ${deletedPayments} pagos y ${deletedCounters} registros de TicketCounter.`
  );

  if (deletedTickets < Number(identified)) {
    warn(
      `Advertencia: se identificaron ${identified.toString()} tickets pero solo se eliminaron ${deletedTickets}. Verifica bloqueos o restricciones adicionales.`
    );
  }

  return {
    identified: Number(identified),
    deletedTickets,
    deletedJugadas,
    deletedPayments,
    deletedCounters,
    dryRun: false,
  };
}


