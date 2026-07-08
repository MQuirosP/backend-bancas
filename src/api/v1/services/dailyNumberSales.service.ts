import prisma from "../../../core/prismaClient";
import { Prisma } from "../../../generated/prisma/client";
import logger from "../../../core/logger";

export class DailyNumberSalesService {
  /**
   * Agrega las ventas por número de un sorteo y las almacena de forma atómica e idempotente.
   * Ejecutado completamente en la base de datos para no consumir memoria Node.js.
   */
  static async aggregateSorteoSales(sorteoId: string): Promise<void> {
    logger.info({
      layer: "service",
      action: "DAILY_NUMBER_SALES_AGGREGATION_START",
      payload: { sorteoId },
    });

    // Usar una transacción para asegurar atomicidad con timeout ampliado de 30 segundos
    await prisma.$transaction(async (tx) => {
      // 1. Limpiar agregaciones anteriores del sorteo para evitar duplicidad
      await tx.$executeRaw`
        DELETE FROM "DailyNumberSales"
        WHERE "sorteoId" = ${sorteoId}::uuid
      `;

      // 2. Insertar la agregación calculada directamente en base de datos
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

    logger.info({
      layer: "service",
      action: "DAILY_NUMBER_SALES_AGGREGATION_SUCCESS",
      payload: { sorteoId },
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
