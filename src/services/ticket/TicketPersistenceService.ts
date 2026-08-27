import { Prisma, TicketStatus } from "../../generated/prisma/client";
import logger from "../../core/logger";
import { DailyNumberSalesService } from "../../api/v1/services/dailyNumberSales.service";
import {
  CreateTicketInput,
  CreateTicketOptions,
  PreparedCommissions,
  TransactionMeta,
  TransactionSaveResult,
} from "./ticket.types";

export type TicketSaveContext = {
  data: CreateTicketInput;
  meta: TransactionMeta;
  ticketNumber: string;
  seqForLog: number | null;
  totalAmountTx: number;
  commissions: PreparedCommissions;
  warnings: any[];
  userId: string;
  options?: CreateTicketOptions;
};

export class TicketPersistenceService {
  /**
   * Inserta en la transacción el Ticket, sus Jugadas en batch e invoca la agregación en DailyNumberSales.
   * REGLA DE ORO: Recibe explícitamente tx: Prisma.TransactionClient.
   */
  static async save(
    tx: Prisma.TransactionClient,
    context: TicketSaveContext
  ): Promise<TransactionSaveResult> {
    const {
      data,
      meta,
      ticketNumber,
      seqForLog,
      totalAmountTx,
      commissions,
      warnings,
      userId,
      options,
    } = context;

    const { loteriaId, sorteoId, ventanaId, clienteNombre } = data;
    const { bancaId, businessDateInfo, sorteo } = meta;
    const {
      jugadasWithCommissions,
      commissionsDetails,
      totalCommission,
      totalListeroCommission,
    } = commissions;

    const normalizedClienteNombre =
      clienteNombre?.trim() || "CLIENTE CONTADO";

    const createdTicket = await tx.ticket.create({
      data: {
        ticketNumber,
        businessDate: businessDateInfo.businessDate,
        bancaId,
        loteriaId,
        sorteoId,
        ventanaId,
        vendedorId: userId,
        totalAmount: totalAmountTx,
        totalCommission,
        totalListeroCommission,
        status: TicketStatus.ACTIVE,
        isActive: true,
        clienteNombre: normalizedClienteNombre,
        createdBy: options?.createdBy ?? null,
        createdByRole: options?.createdByRole ?? null,
        idempotencyKey: options?.idempotencyKey ?? null,
      },
    });

    const BATCH_SIZE = 500;
    for (let i = 0; i < jugadasWithCommissions.length; i += BATCH_SIZE) {
      const batch = jugadasWithCommissions.slice(i, i + BATCH_SIZE);
      await tx.jugada.createMany({
        data: batch.map((j) => ({
          ticketId: createdTicket.id,
          bancaId,
          type: j.type,
          number: j.number,
          reventadoNumber: j.reventadoNumber,
          amount: j.amount,
          finalMultiplierX: j.finalMultiplierX,
          commissionPercent: j.commissionPercent,
          commissionAmount: j.commissionAmount,
          commissionOrigin: j.commissionOrigin,
          commissionRuleId: (j as any).commissionRuleId,
          listeroCommissionAmount: (j as any).listeroCommissionAmount,
          multiplierId: (j as any).multiplierId,
        })),
      });
    }

    await DailyNumberSalesService.incrementFromTicket(createdTicket.id, tx);

    logger.info({
      layer: "repository",
      action: "TICKET_FOLIO_DIAG",
      payload: {
        createdAtUTC: new Date().toISOString(),
        scheduledAt: sorteo?.scheduledAt ? new Date(sorteo.scheduledAt).toISOString() : null,
        businessDateISO: businessDateInfo.businessDateISO,
        prefixYYMMDD: businessDateInfo.prefixYYMMDD,
        counter: seqForLog,
        ticketNumber,
        optimized: true,
      },
    });

    return {
      createdTicketId: createdTicket.id,
      jugadasWithCommissions,
      commissionsDetails,
      ticketNumber,
      warnings,
      seqForLog,
    };
  }
}
