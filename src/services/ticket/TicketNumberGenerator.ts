import { Prisma } from "../../generated/prisma/client";
import logger from "../../core/logger";
import { AppError } from "../../core/errors";

export class TicketNumberGenerator {
  /**
   * Genera atómicamente el número de ticket ejecutando el stored procedure SQL en PostgreSQL.
   * REGLA DE ORO: Recibe explícitamente tx: Prisma.TransactionClient.
   */
  static async generate(
    tx: Prisma.TransactionClient,
    businessDateISO: string
  ): Promise<{ ticketNumber: string; seqForLog: number | null }> {
    let nextNumber = '';
    let seqForLog: number | null = null;

    try {
      const seqRows = await tx.$queryRaw<{ ticket_number: string }[]>(
        Prisma.sql`SELECT generate_ticket_number_v4(${businessDateISO}::text::date) AS ticket_number`
      );

      if (!seqRows?.[0]?.ticket_number) {
        throw new AppError(
          'No se pudo generar número de ticket',
          500,
          'SEQ_ERROR'
        );
      }

      nextNumber = seqRows[0].ticket_number;
      const seqStr = nextNumber.split('-')[1];
      seqForLog = seqStr ? parseInt(seqStr, 10) : null;

      logger.info({
        layer: 'repository',
        action: 'TICKET_NUMBER_GENERATED',
        payload: {
          ticketNumber: nextNumber,
          businessDate: businessDateISO,
          sequence: seqForLog,
        },
      });
    } catch (error: any) {
      logger.error({
        layer: 'repository',
        action: 'TICKET_NUMBER_GENERATION_ERROR',
        payload: { error: error.message },
      });
      throw error instanceof AppError
        ? error
        : new AppError(
          'Error al generar número de ticket',
          500,
          'TICKET_NUMBER_ERROR'
        );
    }

    if (!nextNumber) {
      throw new AppError('Failed to generate ticket number', 500, 'SEQ_ERROR');
    }

    return { ticketNumber: nextNumber, seqForLog };
  }
}
