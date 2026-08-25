import prisma from "../../../core/prismaClient";
import { Prisma } from "../../../generated/prisma/client";
import logger from "../../../core/logger";

export class DailyNumberSalesService {
  /**
   * Acumula de forma incremental y atómica los números de un ticket en DailyNumberSales.
   * Ejecutado dentro de la transacción de creación o restauración del ticket.
   * Garantiza uso de Index Scan / Index Only Scan sobre la restricción única ("businessDate", "sorteoId", "vendedorId", "number", "type").
   */
  static async incrementFromTicket(ticketId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "DailyNumberSales" (
        "id", "businessDate", "bancaId", "ventanaId", "vendedorId", "loteriaId", "sorteoId",
        "number", "type", "totalAmount", "ticketsCount", "jugadasCount"
      )
      SELECT
        gen_random_uuid(),
        t."businessDate",
        COALESCE(t."bancaId", 'da3545ac-fb10-4674-a345-6b66c9f89146'::uuid),
        t."ventanaId",
        t."vendedorId",
        t."loteriaId",
        t."sorteoId",
        j.number,
        j.type,
        SUM(j.amount)::double precision,
        1,
        COUNT(j.id)::integer
      FROM "Jugada" j
      INNER JOIN "Ticket" t ON j."ticketId" = t.id
      WHERE t.id = ${ticketId}::uuid AND j."deletedAt" IS NULL
      GROUP BY t."businessDate", t."bancaId", t."ventanaId", t."vendedorId", t."loteriaId", t."sorteoId", j.number, j.type
      ON CONFLICT ("businessDate", "sorteoId", "vendedorId", "number", "type")
      DO UPDATE SET
        "totalAmount" = "DailyNumberSales"."totalAmount" + EXCLUDED."totalAmount",
        "ticketsCount" = "DailyNumberSales"."ticketsCount" + EXCLUDED."ticketsCount",
        "jugadasCount" = "DailyNumberSales"."jugadasCount" + EXCLUDED."jugadasCount";
    `;
  }

  /**
   * Decrementa de forma incremental los números de un ticket cancelado o anulado en DailyNumberSales.
   * Ejecutado dentro de la transacción de cancelación del ticket.
   */
  static async decrementFromTicket(ticketId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`
      WITH ticket_summary AS (
        SELECT
          t."businessDate",
          t."sorteoId",
          t."vendedorId",
          j.number,
          j.type,
          SUM(j.amount)::double precision as amount_sum,
          COUNT(j.id)::integer as jugadas_cnt
        FROM "Jugada" j
        INNER JOIN "Ticket" t ON j."ticketId" = t.id
        WHERE t.id = ${ticketId}::uuid
        GROUP BY t."businessDate", t."sorteoId", t."vendedorId", j.number, j.type
      )
      UPDATE "DailyNumberSales" dns
      SET
        "totalAmount" = GREATEST(0, dns."totalAmount" - ts.amount_sum),
        "ticketsCount" = GREATEST(0, dns."ticketsCount" - 1),
        "jugadasCount" = GREATEST(0, dns."jugadasCount" - ts.jugadas_cnt)
      FROM ticket_summary ts
      WHERE dns."businessDate" = ts."businessDate"
        AND dns."sorteoId" = ts."sorteoId"
        AND dns."vendedorId" = ts."vendedorId"
        AND dns."number" = ts.number
        AND dns."type" = ts.type;
    `;
  }

  /**
   * REFACTORIZADO (Fase 2 - Agregación Incremental):
   * Las agregaciones se mantienen en tiempo real por evento de ticket (0ms al cierre).
   * Este método omite el barrido masivo durante la evaluación del sorteo.
   */
  static async aggregateSorteoSales(sorteoId: string): Promise<void> {
    logger.info({
      layer: "service",
      action: "DAILY_NUMBER_SALES_AGGREGATION_INCREMENTAL_SKIPPED",
      payload: {
        sorteoId,
        reason: "DailyNumberSales is maintained in real-time via incremental ticket events (0ms disk sweep)."
      },
    });
  }

  /**
   * Reconstrucción manual completa de un sorteo (usado exclusivamente en herramientas CLI de auditoría)
   */
  static async rebuildSorteoSalesManual(sorteoId: string): Promise<void> {
    logger.info({
      layer: "service",
      action: "DAILY_NUMBER_SALES_MANUAL_REBUILD_START",
      payload: { sorteoId },
    });

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        DELETE FROM "DailyNumberSales"
        WHERE "sorteoId" = ${sorteoId}::uuid
      `;

      await tx.$executeRaw`
        INSERT INTO "DailyNumberSales" (
          "id", "businessDate", "bancaId", "ventanaId", "vendedorId", "loteriaId", "sorteoId",
          "number", "type", "totalAmount", "ticketsCount", "jugadasCount"
        )
        SELECT
          gen_random_uuid() as "id",
          t."businessDate",
          COALESCE(t."bancaId", 'da3545ac-fb10-4674-a345-6b66c9f89146'::uuid) as "bancaId",
          t."ventanaId",
          t."vendedorId",
          t."loteriaId",
          t."sorteoId",
          j.number,
          j.type,
          COALESCE(SUM(j.amount), 0)::double precision as "totalAmount",
          COUNT(DISTINCT j."ticketId")::integer as "ticketsCount",
          COUNT(j.id)::integer as "jugadasCount"
        FROM "Jugada" j
        INNER JOIN "Ticket" t ON j."ticketId" = t.id
        WHERE t."sorteoId" = ${sorteoId}::uuid
          AND t."deletedAt" IS NULL
          AND t."isActive" = true
          AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
          AND j."deletedAt" IS NULL
        GROUP BY t."businessDate", t."bancaId", t."ventanaId", t."vendedorId", t."loteriaId", t."sorteoId", j.number, j.type
      `;
    }, {
      timeout: 30000
    });
  }

  /**
   * Elimina las agregaciones de un sorteo (usado en re-evaluación o rollback de sorteos)
   */
  static async deleteSorteoSales(sorteoId: string): Promise<void> {
    logger.info({
      layer: "service",
      action: "DAILY_NUMBER_SALES_DELETE_START",
      payload: { sorteoId },
    });

    await prisma.dailyNumberSales.deleteMany({
      where: { sorteoId },
    });

    logger.info({
      layer: "service",
      action: "DAILY_NUMBER_SALES_DELETE_SUCCESS",
      payload: { sorteoId },
    });
  }
}
