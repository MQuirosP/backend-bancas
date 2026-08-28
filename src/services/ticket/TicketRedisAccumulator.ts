import { BetType } from "../../generated/prisma/client";
import { ReportDimension } from "../../types/enums/report.enum";
import prisma from "../../core/prismaClient";
import logger from "../../core/logger";
import { getRedisClient, isRedisAvailable, markRedisError } from "../../core/redisClient";
import { CreateTicketOptions } from "./ticket.types";

export class TicketRedisAccumulator {
  /**
   * Ejecuta el pipeline de Redis post-transacción de manera síncrona (esperando confirmación).
   * Incrementa los acumulados por banca, ventana, vendedor y tipo/multiplicador.
   * Garantiza consistencia instantánea antes de responder HTTP al cliente.
   */
  static async increment(
    ticket: any,
    sorteoScheduledAt: Date | null | undefined,
    options?: CreateTicketOptions
  ): Promise<void> {
    if (!isRedisAvailable()) return;

    const redis = getRedisClient();
    if (!redis) return;

    try {
      const pipeline = redis.pipeline();

      // Calcular TTL dinámico e inteligente para el sorteo
      let ttlSeconds = 43200; // 12 horas por defecto
      if (sorteoScheduledAt) {
        const msToDraw = new Date(sorteoScheduledAt).getTime() - Date.now();
        const twoHoursMs = 2 * 60 * 60 * 1000;
        const calculatedTtl = Math.ceil((msToDraw + twoHoursMs) / 1000);
        ttlSeconds = Math.max(7200, Math.min(calculatedTtl, 86400));
      }

      // Obtener la bancaId real para el incremento
      let targetBancaId = options?.preFetched?.ventana?.bancaId;
      if (!targetBancaId && ticket.ventana?.bancaId) {
        targetBancaId = ticket.ventana.bancaId;
      }
      if (!targetBancaId) {
        const vent = await prisma.ventana.findUnique({
          where: { id: ticket.ventanaId },
          select: { bancaId: true },
        });
        targetBancaId = vent?.bancaId;
      }

      if (targetBancaId) {
        const scopes = [
          { id: targetBancaId, type: ReportDimension.BANCA },
          { id: ticket.ventanaId, type: ReportDimension.VENTANA },
          { id: ticket.vendedorId, type: ReportDimension.VENDEDOR },
        ];

        const keysToExpire = new Set<string>();

        for (const j of ticket.jugadas || []) {
          const amount = j.amount;
          const num = j.number;

          for (const sc of scopes) {
            if (!sc.id) continue;

            // 1. Clave general
            const genKey = `sorteo:${ticket.sorteoId}:scope:${sc.id}:acumulados`;
            pipeline.hincrbyfloat(genKey, num, amount);
            keysToExpire.add(genKey);

            // 2. Clave por multiplicador
            const multId =
              j.type === BetType.REVENTADO
                ? "REVENTADO"
                : j.multiplierId;

            if (multId) {
              const multKey = `sorteo:${ticket.sorteoId}:scope:${sc.id}:multiplier:${multId}:acumulados`;
              pipeline.hincrbyfloat(multKey, num, amount);
              keysToExpire.add(multKey);
            }
          }
        }

        // Aplicar expiración una sola vez por clave única
        for (const key of keysToExpire) {
          pipeline.expire(key, ttlSeconds);
        }

        await pipeline.exec();

        logger.debug({
          layer: "redis-update",
          action: "ACCUMULATED_REDIS_INCREMENTED",
          payload: {
            ticketId: ticket.id,
            sorteoId: ticket.sorteoId,
            bancaId: targetBancaId,
            jugadasCount: ticket.jugadas?.length || 0,
          },
        });
      }
    } catch (redisErr: any) {
      markRedisError("createOptimized-increment");
      logger.error({
        layer: "redis-update",
        action: "REDIS_INCREMENT_ERROR",
        payload: { ticketId: ticket.id, error: redisErr.message },
      });
    }
  }

  /**
   * Alias retrocompatible para llamadas asíncronas sin await
   */
  static incrementAsync(
    ticket: any,
    sorteoScheduledAt: Date | null | undefined,
    options?: CreateTicketOptions
  ): void {
    TicketRedisAccumulator.increment(ticket, sorteoScheduledAt, options).catch(() => {});
  }
}
