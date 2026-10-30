import prisma from "../../../core/prismaClient";
import { withConnectionRetry } from "../../../core/withConnectionRetry";
import { AppError } from "../../../core/errors";
import logger from "../../../core/logger";
import ActivityService from "../../../core/activity.service";
import { ActivityType, Role } from "../../../generated/prisma/client";
import TicketRepository from "../../../repositories/ticket.repository";
import { RestrictionRuleRepository } from "../../../repositories/restrictionRule.repository";
import { CacheService } from "../../../core/cache.service";
import { BackgroundTaskQueue } from "../../../utils/concurrency";
import { nowCR } from "../../../utils/datetime";
import { TicketPrintService } from "../TicketPrintService";
import { VendorCreditService } from "../../credit/vendorCredit.service";
import { RestrictionRuleService } from "../../restriction/restrictionRule.service";

const CUTOFF_GRACE_MS = 1000;

export class TicketOperationsService {
  /**
   * Obtiene un ticket por su ID con relaciones y configuraciones de impresión enriquecidas
   */
  static async getById(id: string, bancaId?: string) {
    const ticket = await TicketRepository.getById(id, bancaId);

    if (!ticket) {
      throw new AppError("Ticket no encontrado", 404);
    }

    if (!ticket.sorteo) {
      logger.error({
        layer: "service",
        action: "TICKET_GET_BY_ID_SORTEO_MISSING",
        payload: {
          ticketId: id,
          sorteoId: ticket.sorteoId,
          message: "El ticket no tiene un sorteo asociado válido",
        },
      });
      throw new AppError("El ticket no tiene un sorteo asociado válido", 500);
    }

    if (!ticket.sorteo.name || ticket.sorteo.name.trim() === "") {
      logger.warn({
        layer: "service",
        action: "TICKET_GET_BY_ID_SORTEO_NAME_MISSING",
        payload: {
          ticketId: id,
          sorteoId: ticket.sorteoId,
          sorteo: {
            id: ticket.sorteo.id,
            name: ticket.sorteo.name,
            scheduledAt: ticket.sorteo.scheduledAt,
            status: ticket.sorteo.status,
          },
          message: "El sorteo asociado no tiene nombre o está vacío",
        },
      });
      throw new AppError("El sorteo asociado no tiene nombre válido", 500);
    }

    const [vendedor, ventanaData] = await withConnectionRetry(
      () =>
        Promise.all([
          prisma.user.findUnique({
            where: { id: ticket.vendedorId },
            select: { name: true, phone: true, settings: true },
          }),
          prisma.ventana.findUnique({
            where: { id: ticket.ventanaId },
            select: { name: true, phone: true, settings: true },
          }),
        ]),
      { context: "TicketOperationsService.reprint.printConfigs" },
    );

    const sorteoWithFormattedName = {
      ...ticket.sorteo,
      name: TicketPrintService.formatSorteoNameWithTime(
        ticket.sorteo.name,
        ticket.sorteo.scheduledAt,
      ),
    };

    const enriched = {
      ...ticket,
      enableTicketReprints: process.env.ENABLE_TICKET_REPRINTS === "true",
      sorteo: sorteoWithFormattedName,
      vendedor: ticket.vendedor
        ? {
          ...ticket.vendedor,
          ...TicketPrintService.extractPrintConfig(
            vendedor?.settings,
            vendedor?.name || null,
            vendedor?.phone || null,
          ),
        }
        : undefined,
      ventana: ticket.ventana
        ? {
          ...ticket.ventana,
          ...TicketPrintService.extractPrintConfig(
            ventanaData?.settings,
            ventanaData?.name || null,
            ventanaData?.phone || null,
          ),
        }
        : undefined,
    };
    return enriched;
  }

  /**
   * Lista tickets paginados con filtros
   */
  static async list(
    page = 1,
    pageSize = 10,
    filters: any = {},
  ): Promise<ReturnType<typeof TicketRepository.list>> {
    return TicketRepository.list(page, pageSize, filters);
  }

  /**
   * Cancela un ticket validando el cutoff de sorteo
   */
  static async cancel(
    id: string,
    userId: string,
    requestId?: string,
    bancaId?: string,
  ) {
    const existing = await TicketRepository.getById(id, bancaId);
    if (!existing) {
      throw new AppError("Ticket no encontrado", 404, "NOT_FOUND");
    }

    const cutoff = await RestrictionRuleRepository.resolveSalesCutoff({
      bancaId: existing.ventana.bancaId,
      ventanaId: existing.ventanaId,
      userId: existing.vendedorId,
      defaultCutoff: 1,
    });

    const now = nowCR();
    const safeMinutes =
      typeof cutoff.minutes === "number" && !isNaN(cutoff.minutes)
        ? cutoff.minutes
        : 1;

    const cutoffMs = safeMinutes * 60_000;
    const limitTime = new Date(
      existing.sorteo.scheduledAt.getTime() - cutoffMs,
    );
    const effectiveLimitTime = new Date(limitTime.getTime() + CUTOFF_GRACE_MS);

    if (now >= effectiveLimitTime) {
      const minsLeft = Math.max(
        0,
        Math.ceil(
          (existing.sorteo.scheduledAt.getTime() - now.getTime()) / 60_000,
        ),
      );
      throw new AppError(
        `Anulación bloqueada: faltan ${minsLeft} min para el sorteo (cutoff=${safeMinutes} min, fuente=${cutoff.source})`,
        409,
        "SALES_CUTOFF_REACHED",
      );
    }

    const ticket = await TicketRepository.cancel(id, userId, bancaId);

    if (ticket.vendedorId) {
      CacheService.invalidateTag(`vendedor:${ticket.vendedorId}`).catch(
        (err) => {
          logger.warn({
            layer: "cache",
            action: "INVALIDATE_ERROR_ON_CANCEL",
            payload: { vendedorId: ticket.vendedorId, error: err.message },
          });
        },
      );
      CacheService.invalidateTag(`user:${ticket.vendedorId}`).catch(() => { });
    }

    await ActivityService.log({
      userId,
      bancaId: existing.ventana.bancaId,
      action: ActivityType.TICKET_CANCEL,
      targetType: "TICKET",
      targetId: id,
      details: {
        ticketNumber: ticket.ticketNumber,
        totalAmount: ticket.totalAmount,
        reason: "Cancelled by user",
        description: `Ticket #${ticket.ticketNumber} cancelado (Monto: ₡${ticket.totalAmount.toLocaleString()})`,
      },
      requestId,
      layer: "service",
    });

    logger.warn({
      layer: "service",
      action: "TICKET_CANCEL",
      userId,
      requestId,
      payload: { ticketId: id },
    });

    // Piggyback creditInfo y sorteoBalances actualizados tras la anulación (0ms overhead)
    if (ticket.vendedorId) {
      try {
        const creditInfo = await VendorCreditService.getVendorCreditInfo(ticket.vendedorId);
        if (creditInfo) (ticket as any).creditInfo = creditInfo;
      } catch (err: any) {
        logger.warn({ layer: "service", action: "PIGGYBACK_CREDIT_INFO_ON_CANCEL_ERROR", payload: { error: err?.message } });
      }

      try {
        RestrictionRuleService.invalidateVendorBalancesL1Cache(ticket.vendedorId, existing.sorteoId);
        const sorteoBalances = await TicketRepository.getSorteoBalances({
          sorteoId: existing.sorteoId,
          vendedorId: ticket.vendedorId,
          bancaId: existing.ventana.bancaId,
          bypassL1Cache: true,
        });
        if (sorteoBalances) (ticket as any).sorteoBalances = sorteoBalances;
      } catch (err: any) {
        logger.warn({ layer: "service", action: "PIGGYBACK_SORTEO_BALANCES_ON_CANCEL_ERROR", payload: { error: err?.message } });
      }
    }

    return ticket;
  }

  /**
   * Incrementa el conteo de reimpresiones de un ticket
   */
  static async incrementPrintCount(id: string, userId: string, requestId?: string) {
    const ticket = await TicketRepository.incrementPrintCount(id);

    BackgroundTaskQueue.enqueue("ActivityService.logTicketReprint", () =>
      ActivityService.log({
        userId,
        bancaId: ticket.bancaId,
        action: ActivityType.TICKET_REPRINT,
        targetType: "TICKET",
        targetId: id,
        details: {
          ticketNumber: ticket.ticketNumber,
          printCount: ticket.printCount,
          description: `Ticket #${ticket.ticketNumber} impreso (Conteo acumulado: ${ticket.printCount})`,
        },
        requestId,
        layer: "service",
      })
    );

    return ticket;
  }

  /**
   * Restaura un ticket cancelado
   */
  static async restore(
    id: string,
    userId: string,
    requestId?: string,
    bancaId?: string,
  ) {
    const ticket = await TicketRepository.restore(id, userId, bancaId);

    if (ticket.vendedorId) {
      CacheService.invalidateTag(`user:${ticket.vendedorId}`).catch(() => { });
      CacheService.invalidateTag(`vendedor:${ticket.vendedorId}`).catch(() => { });
    }

    await ActivityService.log({
      userId,
      bancaId: ticket.bancaId,
      action: ActivityType.TICKET_RESTORE,
      targetType: "TICKET",
      targetId: id,
      details: {
        ticketNumber: ticket.ticketNumber,
        totalAmount: ticket.totalAmount,
        restored: true,
        description: `Ticket #${ticket.ticketNumber} restaurado (Monto: ₡${ticket.totalAmount.toLocaleString()})`,
      },
      requestId,
      layer: "service",
    });

    logger.info({
      layer: "service",
      action: "TICKET_RESTORE",
      userId,
      requestId,
      payload: { ticketId: id },
    });

    return ticket;
  }

  /**
   * Busca un ticket por su llave de idempotencia (usado para recuperación)
   */
  static async getByIdempotencyKey(key: string) {
    const ticket = await prisma.ticket.findFirst({
      where: { idempotencyKey: key, deletedAt: null },
      include: {
        jugadas: true,
      },
    });
    return ticket;
  }

  /**
   * Obtiene los saldos disponibles para todos los números de un sorteo
   */
  static async getBalances(
    sorteoId: string,
    vendedorId: string,
    bancaId?: string,
    actorRole?: Role,
  ) {
    return TicketRepository.getSorteoBalances({
      sorteoId,
      vendedorId,
      bancaId,
      actorRole,
    });
  }
}
