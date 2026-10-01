import { BetType, Prisma } from "../../../generated/prisma/client";
import { salesPrisma } from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import { getBusinessDateCRInfo } from "../../../utils/businessDate";
import { resolveBaseMultiplierX } from "../../../repositories/ticket.repository";
import { CreateTicketInput, CreateTicketOptions, TransactionMeta, PreTxMeta } from "./ticket.types";
import { CacheService } from "../../../core/cache.service";

export class TicketPrefetchService {
  /**
   * Pre-carga los multiplicadores requeridos fuera de la transacción para reducir el hold-time.
   * Utiliza CacheService.wrap con TTL largo (24h) en Redis y L1 para evitar consultas a Postgres.
   */
  static async fetchMultipliersIfNeeded(
    jugadas: CreateTicketInput["jugadas"],
    options?: CreateTicketOptions,
    loteriaId?: string
  ): Promise<any[]> {
    if (options?.preFetched?.multipliers) {
      return options.preFetched.multipliers;
    }

    const numeroMultiplierIds = Array.from(
      new Set(
        jugadas
          .filter((j) => j.type === BetType.NUMERO && j.multiplierId)
          .map((j) => j.multiplierId!)
      )
    );

    if (numeroMultiplierIds.length === 0) {
      return [];
    }

    // 1. Si tenemos loteriaId, consultar el catálogo completo de la lotería desde caché L1/Redis
    if (loteriaId) {
      const cacheKey = `multipliers:loteria:${loteriaId}`;
      const allMultipliers = await CacheService.wrap<any[]>(
        cacheKey,
        () =>
          salesPrisma.loteriaMultiplier.findMany({
            where: { loteriaId, isActive: true },
            select: {
              id: true,
              name: true,
              valueX: true,
              isActive: true,
              kind: true,
              loteriaId: true,
            },
          }),
        86400, // 24 horas TTL en Redis
        [`loteria:${loteriaId}`, `multipliers:${loteriaId}`],
        true, // useL1: true (RAM local)
        86400_000 // 24 horas TTL L1
      );

      if (allMultipliers && allMultipliers.length > 0) {
        const matched = allMultipliers.filter((m) =>
          numeroMultiplierIds.includes(m.id)
        );
        // Si todos los multiplicadores solicitados están en el catálogo cacheado de la lotería
        if (matched.length === numeroMultiplierIds.length) {
          return matched;
        }
      }
    }

    // 2. Fallback directo si no se pasó loteriaId o algún ID no estaba en el catálogo activo
    return await salesPrisma.loteriaMultiplier.findMany({
      where: { id: { in: numeroMultiplierIds } },
      select: {
        id: true,
        name: true,
        valueX: true,
        isActive: true,
        kind: true,
        loteriaId: true,
      },
    });
  }

  /**
   * FAST-PATH PRE-TX: Resuelve entidades estáticas FUERA de la transacción interactiva.
   */
  static async resolvePreTxMetadata(
    data: CreateTicketInput,
    userId: string,
    options?: CreateTicketOptions
  ): Promise<PreTxMeta> {
    const { loteriaId, sorteoId, ventanaId } = data;
    const scheduledAt = options?.scheduledAt;

    const nowUtc = new Date();
    const cutoffHour = (
      process.env.BUSINESS_CUTOFF_HOUR_CR || '00:00'
    ).trim();

    const preFetchedBancaId = options?.preFetched?.ventana?.bancaId as
      | string
      | undefined;

    const [loteria, sorteo, ventana, user, preResolvedMultiplier] =
      await Promise.all([
        options?.preFetched?.loteria
          ? Promise.resolve(options.preFetched.loteria)
          : salesPrisma.loteria.findUnique({
              where: { id: loteriaId },
              select: {
                id: true,
                name: true,
                isActive: true,
                rulesJson: true,
              },
            }),
        options?.preFetched?.sorteo
          ? Promise.resolve(options.preFetched.sorteo)
          : salesPrisma.sorteo.findUnique({
              where: { id: sorteoId },
              select: {
                id: true,
                status: true,
                loteriaId: true,
                scheduledAt: true,
                bancaId: true,
              },
            }),
        options?.preFetched?.ventana
          ? Promise.resolve(options.preFetched.ventana)
          : salesPrisma.ventana.findUnique({
              where: { id: ventanaId },
              select: {
                id: true,
                bancaId: true,
                commissionPolicyJson: true,
                banca: {
                  select: { commissionPolicyJson: true },
                },
              },
            }),
        options?.preFetched?.vendedor
          ? Promise.resolve(options.preFetched.vendedor)
          : salesPrisma.user.findUnique({
              where: { id: userId },
              select: {
                id: true,
                role: true,
                creditLimit: true,
                creditAlertThreshold: true,
                creditBlockMode: true,
                commissionPolicyJson: true,
              },
            }),
        preFetchedBancaId
          ? resolveBaseMultiplierX(salesPrisma as any, {
              bancaId: preFetchedBancaId,
              loteriaId,
              userId,
              ventanaId,
            })
          : Promise.resolve(null),
      ]);

    if (!user)
      throw new AppError('Seller (vendedor) not found', 404, 'FK_VIOLATION');
    if (!loteria || loteria.isActive === false)
      throw new AppError('Lotería not found', 404, 'FK_VIOLATION');
    if (!sorteo)
      throw new AppError('Sorteo not found', 404, 'FK_VIOLATION');
    if (!ventana)
      throw new AppError('Ventana not found', 404, 'FK_VIOLATION');

    if (sorteo.status === 'CLOSED') {
      throw new AppError("No se pueden crear tickets en un sorteo cerrado", 409, 'SORTEO_CLOSED');
    }

    if (sorteo.loteriaId !== loteriaId) {
      throw new AppError(
        'El sorteo no pertenece a la lotería indicada',
        400,
        'SORTEO_LOTERIA_MISMATCH'
      );
    }

    if (sorteo.bancaId && sorteo.bancaId !== ventana.bancaId) {
      throw new AppError(
        'Operación denegada: El sorteo pertenece a otra banca',
        403,
        'CROSS_TENANT_FORBIDDEN'
      );
    }

    const bd = getBusinessDateCRInfo({
      scheduledAt: scheduledAt ?? sorteo.scheduledAt,
      nowUtc,
      cutoffHour,
    });

    const effectiveBaseMultiplier = preResolvedMultiplier
      ? preResolvedMultiplier
      : await resolveBaseMultiplierX(salesPrisma as any, {
          bancaId: ventana.bancaId,
          loteriaId,
          userId,
          ventanaId,
        });

    return {
      loteria,
      sorteo,
      ventana,
      user,
      bancaId: ventana.bancaId,
      loteriaName: loteria.name ?? null,
      businessDateInfo: bd,
      effectiveBaseX: effectiveBaseMultiplier.valueX,
      preResolvedMultiplier: effectiveBaseMultiplier,
    };
  }

  /**
   * FAST-PATH IN-TX: Solo valida el status del sorteo dentro del lock para evitar carreras con sorteos cerrados.
   */
  static async resolveInTxSorteoStatus(
    tx: Prisma.TransactionClient,
    sorteoId: string
  ): Promise<void> {
    const actualSorteo = await tx.sorteo.findUnique({
      where: { id: sorteoId },
      select: { status: true },
    });
    if (!actualSorteo) throw new AppError('Sorteo no encontrado', 404, 'FK_VIOLATION');
    if (actualSorteo.status === 'CLOSED') {
      throw new AppError("No se pueden crear tickets en un sorteo cerrado", 409, 'SORTEO_CLOSED');
    }
  }

  /**
   * Wrapper legacy por compatibilidad retroactiva.
   */
  static async resolveTransactionMetadata(
    tx: Prisma.TransactionClient,
    data: CreateTicketInput,
    userId: string,
    options?: CreateTicketOptions
  ): Promise<TransactionMeta> {
    const preTxMeta = await this.resolvePreTxMetadata(data, userId, options);
    await this.resolveInTxSorteoStatus(tx, data.sorteoId);
    return preTxMeta as TransactionMeta;
  }
}