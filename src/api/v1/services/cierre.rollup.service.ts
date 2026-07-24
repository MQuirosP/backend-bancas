import { Prisma } from '../../../generated/prisma/client';
import prisma from '../../../core/prismaClient';
import logger from '../../../core/logger';

export class CierreRollupService {
  private static activeRollups = new Map<string, Promise<void>>();
  private static pendingRollups = new Set<string>();

  /**
   * Recalcula la tabla ResumenCierreDiario para una o varias fechas específicas.
   * Elimina los datos existentes de esas fechas y los vuelve a insertar desde cero.
   * 
   * @param startDate Fecha de inicio (inclusive)
   * @param endDate Fecha de fin (inclusive)
   */
  static async aggregateRange(startDate: string, endDate: string): Promise<void> {
    const key = `${startDate}_${endDate}`;

    // Si ya se está ejecutando uno para esta clave
    if (this.activeRollups.has(key)) {
      // Si ya hay uno pendiente para ejecutarse después, simplemente retornamos la promesa existente
      if (this.pendingRollups.has(key)) {
        return this.activeRollups.get(key);
      }

      // Marcamos que hay un requerimiento pendiente de ejecutarse después de que el actual termine
      this.pendingRollups.add(key);

      const nextPromise = this.activeRollups.get(key)!.then(async () => {
        this.pendingRollups.delete(key);
        // Volvemos a ejecutar recursivamente
        await this.runAggregation(startDate, endDate);
      });

      // Actualizamos la promesa activa
      this.activeRollups.set(key, nextPromise);
      return nextPromise;
    }

    // Si no hay ninguno ejecutándose, lo iniciamos
    const promise = this.runAggregation(startDate, endDate).finally(() => {
      this.activeRollups.delete(key);
    });

    this.activeRollups.set(key, promise);
    return promise;
  }

  private static async runAggregation(startDate: string, endDate: string): Promise<void> {
    try {
      logger.info({
        layer: 'service',
        action: 'ROLLUP_AGGREGATE_START',
        payload: { startDate, endDate },
      });

      // Envolvemos las operaciones en una transacción usando el Advisory Lock de Postgres
      await prisma.$transaction(async (tx) => {
        const lockKey = `${startDate}_${endDate}`;
        // pg_advisory_xact_lock bloquea por la duración de la transacción y se libera automáticamente al hacer commit o rollback.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

        // 1. Eliminar datos existentes en el rango para asegurar idempotencia
        await tx.$executeRaw`
          DELETE FROM "ResumenCierreDiario"
          WHERE "businessDate" >= ${startDate}::date AND "businessDate" <= ${endDate}::date
        `;

        // 2. Ejecutar el insert desde la agregación
        // Utilizamos un CTE muy similar a la vista materializada original,
        // pero filtrado estrictamente por el rango de fechas.
        const result = await tx.$executeRaw`
          WITH relevant_tickets AS (
            SELECT t.id,
               t."businessDate",
               t."bancaId",
               t."vendedorId",
               t."ventanaId",
               t."loteriaId",
               t."sorteoId",
               t."createdAt"
              FROM "Ticket" t
                JOIN "Sorteo" s ON t."sorteoId" = s.id
             WHERE t."isActive" = true 
               AND t."deletedAt" IS NULL 
               AND t.status <> 'CANCELLED'::"TicketStatus" 
               AND s.status = 'EVALUATED'::"SorteoStatus"
               AND t."businessDate" >= ${startDate}::date 
               AND t."businessDate" <= ${endDate}::date
           ), lm_active AS (
            SELECT lm."loteriaId",
               lm."valueX",
               lm."appliesToDate",
               lm."appliesToSorteoId"
              FROM "LoteriaMultiplier" lm
             WHERE lm.kind = 'NUMERO'::"MultiplierKind" AND lm."isActive" = true
           ), numero_bandas AS (
            SELECT j."ticketId",
               j.number,
               min(j."finalMultiplierX") AS banda
              FROM "Jugada" j
                JOIN relevant_tickets rt ON rt.id = j."ticketId"
             WHERE j.type = 'NUMERO'::"BetType" AND j."isActive" = true AND j."deletedAt" IS NULL
             GROUP BY j."ticketId", j.number
           ), calculated_jugadas AS (
            SELECT rt."businessDate",
               rt."bancaId",
               rt."vendedorId",
               rt."ventanaId",
               rt."loteriaId",
               rt."sorteoId",
               j.type,
                   CASE
                       WHEN j.type = 'NUMERO'::"BetType" AND (EXISTS ( SELECT 1
                          FROM lm_active lm
                         WHERE lm."loteriaId" = rt."loteriaId" AND lm."valueX" = j."finalMultiplierX" AND (lm."appliesToDate" IS NULL OR rt."createdAt" >= lm."appliesToDate") AND (lm."appliesToSorteoId" IS NULL OR lm."appliesToSorteoId" = rt."sorteoId"))) THEN j."finalMultiplierX"
                       WHEN j.type = 'REVENTADO'::"BetType" THEN nb.banda
                       ELSE NULL::double precision
                   END AS banda,
               j.amount,
               j.payout,
               j."listeroCommissionAmount",
               j.id AS "jugadaId",
               rt.id AS "ticketId"
              FROM "Jugada" j
                JOIN relevant_tickets rt ON j."ticketId" = rt.id
                LEFT JOIN numero_bandas nb ON nb."ticketId" = j."ticketId" AND nb.number = j.number AND j.type = 'REVENTADO'::"BetType"
             WHERE j."isActive" = true AND j."deletedAt" IS NULL AND j."isExcluded" = false
           )
           INSERT INTO "ResumenCierreDiario" (
              "id", "bancaId", "businessDate", "vendedorId", "ventanaId", 
              "loteriaId", "sorteoId", "tipo", "banda", "totalVendida", 
              "ganado", "comisionTotal", "ticketsCount", "jugadasCount", 
              "createdAt", "updatedAt"
           )
           SELECT gen_random_uuid(),
              "bancaId",
              "businessDate",
              "vendedorId",
              "ventanaId",
              "loteriaId",
              "sorteoId",
              type AS tipo,
              banda,
              sum(amount) AS "totalVendida",
              sum(COALESCE(payout, 0::double precision)) AS ganado,
              sum(COALESCE("listeroCommissionAmount", 0::double precision)) AS "comisionTotal",
              count(DISTINCT "ticketId")::integer AS "ticketsCount",
              count("jugadaId")::integer AS "jugadasCount",
              NOW(), NOW()
             FROM calculated_jugadas
            WHERE banda IS NOT NULL
            GROUP BY "bancaId", "businessDate", "vendedorId", "ventanaId", "loteriaId", "sorteoId", type, banda
        `;

        logger.info({
          layer: 'service',
          action: 'ROLLUP_AGGREGATE_SUCCESS',
          payload: { startDate, endDate, rowsInserted: result },
        });
      }, {
        timeout: 30000 // 30 segundos de timeout para asegurar que el lock y el cálculo finalicen bien
      });

    } catch (error) {
      logger.error({
        layer: 'service',
        action: 'ROLLUP_AGGREGATE_ERROR',
        meta: { error: error instanceof Error ? error.message : String(error) },
        payload: { startDate, endDate }
      });
      throw error;
    }
  }
}
