import { BetType, Prisma } from "../../generated/prisma/client";
import prisma from "../../core/prismaClient";
import { AppError } from "../../core/errors";
import { getBusinessDateCRInfo } from "../../utils/businessDate";
import { resolveBaseMultiplierX } from "../../repositories/ticket.repository";
import { CreateTicketInput, CreateTicketOptions, TransactionMeta } from "./ticket.types";

export class TicketPrefetchService {
  /**
   * Pre-carga los multiplicadores requeridos fuera de la transacción para reducir el hold-time.
   */
  static async fetchMultipliersIfNeeded(
    jugadas: CreateTicketInput["jugadas"],
    options?: CreateTicketOptions
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

    if (numeroMultiplierIds.length > 0) {
      return await prisma.loteriaMultiplier.findMany({
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

    return [];
  }

  /**
   * Resuelve las entidades secundarias y metadatos dentro de la transacción usando Promise.all en paralelo.
   * REGLA DE ORO: Recibe explícitamente tx: Prisma.TransactionClient.
   */
  static async resolveTransactionMetadata(
    tx: Prisma.TransactionClient,
    data: CreateTicketInput,
    userId: string,
    options?: CreateTicketOptions
  ): Promise<TransactionMeta> {
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
          : tx.loteria.findUnique({
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
          : tx.sorteo.findUnique({
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
          : tx.ventana.findUnique({
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
          : tx.user.findUnique({
            where: { id: userId },
            select: { id: true, commissionPolicyJson: true },
          }),
        preFetchedBancaId
          ? resolveBaseMultiplierX(tx, {
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

    // Double check sorteo status inside transaction to prevent race conditions on CLOSED sorteos
    const actualSorteo = await tx.sorteo.findUnique({
      where: { id: sorteoId },
      select: { status: true }
    });
    if (!actualSorteo) throw new AppError('Sorteo no encontrado', 404, 'FK_VIOLATION');
    if (actualSorteo.status === 'CLOSED') {
      throw new AppError("No se pueden crear tickets en un sorteo cerrado", 409, 'SORTEO_CLOSED');
    }

    if (sorteo.loteriaId !== loteriaId) {
      throw new AppError(
        'El sorteo no pertenece a la lotería indicada',
        400,
        'SORTEO_LOTERIA_MISMATCH'
      );
    }

    // VALIDACIÓN DE SEGURIDAD MULTI-TENANT
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
      : await resolveBaseMultiplierX(tx, {
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
}
