import TicketRepository from "../../../../repositories/ticket.repository";
import { withConnectionRetry } from "../../../../core/withConnectionRetry";
import prisma from "../../../../core/prismaClient";
import logger from "../../../../core/logger";

export const TicketPersistenceService = {
  async createTicketOptimized(
    params: {
      loteriaId: string;
      sorteoId: string;
      ventanaId: string;
      clienteNombre: string | null;
      jugadas: any[];
    },
    effectiveVendedorId: string,
    options: any,
    clientIdempotencyKey: string | undefined,
    userId: string,
    requestId?: string
  ) {
    try {
      const { ticket, warnings } = await TicketRepository.createOptimized(
        params,
        effectiveVendedorId,
        options
      );
      return { ticket, warnings };
    } catch (err: any) {
      if (
        err?.code === 'P2002' &&
        (err?.meta?.target as string[] | undefined)?.includes('idempotencyKey')
      ) {
        const row = await withConnectionRetry(
          () => prisma.$queryRaw<{ id: string }[]>`
            SELECT id FROM "Ticket"
            WHERE "idempotencyKey" = ${clientIdempotencyKey}
              AND "deletedAt" IS NULL
            LIMIT 1
          `,
          { context: 'TicketPersistenceService.create.idempotencyRaceRecover' }
        );
        if (row.length > 0) {
          logger.info({
            layer: 'service',
            action: 'TICKET_CREATE_DB_IDEMPOTENCY_RACE_HIT',
            userId,
            requestId,
            payload: { idempotencyKey: clientIdempotencyKey },
          });
          const ticket = await TicketRepository.getById(row[0].id);
          return { ticket, warnings: [] };
        }
      }
      throw err;
    }
  }
};
