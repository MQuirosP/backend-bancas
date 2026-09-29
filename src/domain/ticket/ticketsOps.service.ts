import prisma from '../../core/prismaClient';
import { TicketStatus, ActivityType, Prisma } from '../../generated/prisma/client';
import { DailyNumberSalesService } from '../sorteo/dailyNumberSales.service';
import { CierreRollupService } from '../cierre/cierre.rollup.service';
import { AccountStatementSyncService } from '../accounts/accounts.sync.service';
import { recalculateMonthlyClosingForDimension } from '../accounts/monthlyClosing.service';
import ActivityService from '../../core/activity.service';
import { tz } from '../../utils/timezone';
import { AppError } from '../../core/errors';
import logger from '../../core/logger';

export interface TicketPreviewInfo {
  id: string;
  ticketNumber: string;
  businessDate: string;
  status: TicketStatus;
  isActive: boolean;
  totalAmount: number;
  totalPayout: number;
  totalPaid: number;
  isWinner: boolean;
  deletedAt: Date | null;
  deletedReason: string | null;
  sorteo: {
    id: string;
    name: string;
    status: string;
    scheduledAt: Date;
    winningNumber: string | null;
  };
  vendedor: {
    id: string;
    name: string;
    ventanaId: string | null;
    bancaId: string | null;
  };
  ventana: {
    id: string;
    name: string;
    bancaId: string | null;
  };
  banca: {
    id: string;
    name: string;
  };
  jugadasCount: number;
  paymentsCount: number;
}

export interface CancelTicketsOpsOptions {
  ticketNumbers: string[];
  reason: string;
  forceWithPayments?: boolean;
}

export interface CancelTicketsOpsResult {
  success: boolean;
  cancelledTickets: {
    id: string;
    ticketNumber: string;
    totalAmount: number;
    totalPayout: number;
    wasWinner: boolean;
    sorteoName: string;
    vendedorName: string;
    bancaName: string;
    businessDate: string;
  }[];
  skippedTickets: {
    ticketNumber: string;
    reason: string;
  }[];
  datesResynced: string[];
  bancasAffected: string[];
  message: string;
}

export class TicketsOpsService {
  /**
   * Busca y previsualiza los tickets por su número consecutivo (ticketNumber)
   */
  static async findTicketsByNumbers(ticketNumbers: string[]): Promise<TicketPreviewInfo[]> {
    const cleanNumbers = ticketNumbers.map(n => n.trim().toUpperCase()).filter(Boolean);
    if (cleanNumbers.length === 0) return [];

    const tickets = await prisma.ticket.findMany({
      where: {
        ticketNumber: { in: cleanNumbers }
      },
      include: {
        sorteo: {
          select: {
            id: true,
            name: true,
            status: true,
            scheduledAt: true,
            winningNumber: true,
            bancaId: true
          }
        },
        vendedor: {
          select: {
            id: true,
            name: true,
            ventanaId: true,
            bancaId: true
          }
        },
        ventana: {
          select: {
            id: true,
            name: true,
            bancaId: true
          }
        },
        banca: {
          select: {
            id: true,
            name: true
          }
        },
        TicketPayment: true,
        _count: {
          select: { jugadas: true }
        }
      }
    });

    return tickets.map(t => {
      const bDateStr = t.businessDate
        ? tz.toDateStr(t.businessDate)
        : tz.toDateStr(t.createdAt);

      return {
        id: t.id,
        ticketNumber: t.ticketNumber,
        businessDate: bDateStr,
        status: t.status,
        isActive: t.isActive,
        totalAmount: Number(t.totalAmount || 0),
        totalPayout: Number(t.totalPayout || 0),
        totalPaid: Number(t.totalPaid || 0),
        isWinner: t.isWinner,
        deletedAt: t.deletedAt,
        deletedReason: t.deletedReason,
        sorteo: {
          id: t.sorteo.id,
          name: t.sorteo.name,
          status: t.sorteo.status,
          scheduledAt: t.sorteo.scheduledAt,
          winningNumber: t.sorteo.winningNumber
        },
        vendedor: {
          id: t.vendedor.id,
          name: t.vendedor.name,
          ventanaId: t.vendedor.ventanaId,
          bancaId: t.vendedor.bancaId
        },
        ventana: {
          id: t.ventana.id,
          name: t.ventana.name,
          bancaId: t.ventana.bancaId
        },
        banca: {
          id: t.banca?.id || t.sorteo.bancaId || '',
          name: t.banca?.name || 'Global'
        },
        jugadasCount: t._count.jugadas,
        paymentsCount: t.TicketPayment.length
      };
    });
  }

  /**
   * Anula tickets por su número consecutivo, revierte sus efectos contables y resincroniza el arrastre
   */
  static async cancelTickets(options: CancelTicketsOpsOptions): Promise<CancelTicketsOpsResult> {
    const { ticketNumbers, reason, forceWithPayments = false } = options;
    const cleanNumbers = ticketNumbers.map(n => n.trim().toUpperCase()).filter(Boolean);

    if (cleanNumbers.length === 0) {
      throw new AppError('Debe proporcionar al menos un número de ticket.', 400);
    }

    const tickets = await prisma.ticket.findMany({
      where: { ticketNumber: { in: cleanNumbers } },
      include: {
        sorteo: true,
        vendedor: { select: { id: true, name: true, ventanaId: true, bancaId: true } },
        ventana: { select: { id: true, name: true, bancaId: true } },
        banca: { select: { id: true, name: true } },
        TicketPayment: true
      }
    });

    if (tickets.length === 0) {
      throw new AppError(`No se encontraron tickets con los números: ${cleanNumbers.join(', ')}`, 404);
    }

    const ticketsToCancel: typeof tickets = [];
    const skippedTickets: { ticketNumber: string; reason: string }[] = [];

    for (const t of tickets) {
      if (t.status === TicketStatus.CANCELLED || t.deletedAt !== null) {
        skippedTickets.push({
          ticketNumber: t.ticketNumber,
          reason: `Ya se encuentra cancelado desde ${t.deletedAt ? tz.toDateStr(t.deletedAt) : 'previamente'}`
        });
        continue;
      }

      if (t.TicketPayment.length > 0 && !forceWithPayments) {
        throw new AppError(
          `El ticket ${t.ticketNumber} tiene pagos registrados (${t.TicketPayment.length} pagos, total pagado: ${t.totalPaid}). Se requiere confirmación explícita (forceWithPayments) para anular un ticket con pagos.`,
          400
        );
      }

      ticketsToCancel.push(t);
    }

    if (ticketsToCancel.length === 0) {
      return {
        success: true,
        cancelledTickets: [],
        skippedTickets,
        datesResynced: [],
        bancasAffected: [],
        message: 'No hubo tickets que requerían anulación.'
      };
    }

    const now = new Date();

    // 1. Ejecución Transaccional Atómica
    await prisma.$transaction(async (tx) => {
      for (const t of ticketsToCancel) {
        // A. Si tenía pagos registrados y se forzó, eliminarlos
        if (t.TicketPayment.length > 0) {
          await tx.ticketPayment.deleteMany({
            where: { ticketId: t.id }
          });
        }

        // B. Anular el ticket (Soft-Delete)
        await tx.ticket.update({
          where: { id: t.id },
          data: {
            status: TicketStatus.CANCELLED,
            isActive: false,
            deletedAt: now,
            deletedBy: 'OPS_CLI',
            deletedReason: reason,
            totalPayout: 0,
            remainingAmount: 0,
            totalPaid: 0,
            isWinner: false,
            updatedAt: now
          }
        });

        // C. Anular todas sus jugadas asociadas
        await tx.jugada.updateMany({
          where: { ticketId: t.id },
          data: {
            isActive: false,
            deletedAt: now,
            deletedBy: 'OPS_CLI',
            deletedReason: reason,
            isWinner: false,
            payout: 0,
            updatedAt: now
          }
        });

        // D. Decrementar ventas del ticket en DailyNumberSales (si aplica)
        await DailyNumberSalesService.decrementFromTicket(t.id, tx as any);

        // E. Si el sorteo estaba EVALUATED y este ticket era ganador,
        // verificar si el sorteo aún tiene otros ganadores activos
        if (t.sorteo.status === 'EVALUATED' && t.isWinner) {
          const remainingWinners = await tx.ticket.count({
            where: {
              sorteoId: t.sorteoId,
              id: { notIn: ticketsToCancel.map(item => item.id) },
              isWinner: true,
              isActive: true,
              deletedAt: null
            }
          });

          if (remainingWinners === 0) {
            await tx.sorteo.update({
              where: { id: t.sorteoId },
              data: { hasWinner: false }
            });
          }
        }
      }
    }, {
      timeout: 30000
    });

    // 2. Post-Transacción: Identificar entidades, sorteos y fechas afectadas
    const affectedSorteoIds = Array.from(new Set(ticketsToCancel.map(t => t.sorteoId)));
    const affectedBusinessDates = Array.from(new Set(ticketsToCancel.map(t => {
      return t.businessDate ? tz.toDateStr(t.businessDate) : tz.toDateStr(t.createdAt);
    }))).sort();

    const affectedVendedores = Array.from(new Set(ticketsToCancel.map(t => t.vendedorId)));
    const affectedVentanas = Array.from(new Set(ticketsToCancel.map(t => t.ventanaId)));
    const affectedBancas = Array.from(new Set(ticketsToCancel.map(t => t.bancaId).filter(Boolean))) as string[];

    // A. Reconstruir acopio DailyNumberSales para cada sorteo afectado
    for (const sorteoId of affectedSorteoIds) {
      await DailyNumberSalesService.rebuildSorteoSalesManual(sorteoId);
    }

    // B. Recalcular rollups ResumenCierreDiario para las fechas de negocio afectadas
    for (const bDateStr of affectedBusinessDates) {
      await CierreRollupService.aggregateRange(bDateStr, bDateStr);
    }

    // C. Re-sincronizar AccountStatement día por día desde la fecha más antigua afectada hasta hoy
    const todayCR = tz.toDateStr();
    const earliestDateStr = affectedBusinessDates[0] < todayCR ? affectedBusinessDates[0] : todayCR;

    const datesToSync: string[] = [];
    const monthsSet = new Set<string>();

    let curr = new Date(earliestDateStr + 'T00:00:00Z');
    const end = new Date(todayCR + 'T00:00:00Z');
    while (curr <= end) {
      const dStr = curr.toISOString().slice(0, 10);
      datesToSync.push(dStr);
      monthsSet.add(dStr.slice(0, 7));
      curr.setUTCDate(curr.getUTCDate() + 1);
    }

    for (const dateStr of datesToSync) {
      const dateObj = new Date(dateStr + 'T00:00:00Z');

      for (const vId of affectedVendedores) {
        await (AccountStatementSyncService as any)._syncDayStatementInternal(dateObj, 'vendedor', vId);
      }
      for (const vtId of affectedVentanas) {
        await (AccountStatementSyncService as any)._syncDayStatementInternal(dateObj, 'ventana', vtId);
      }
      for (const bId of affectedBancas) {
        await (AccountStatementSyncService as any)._syncDayStatementInternal(dateObj, 'banca', bId);
      }
    }

    // D. Recalcular cierres mensuales para los meses afectados
    for (const monthStr of Array.from(monthsSet)) {
      for (const vId of affectedVendedores) {
        const v = ticketsToCancel.find(t => t.vendedorId === vId)?.vendedor;
        await recalculateMonthlyClosingForDimension(monthStr, 'vendedor', v?.ventanaId || undefined, vId, v?.bancaId || undefined);
      }
      for (const vtId of affectedVentanas) {
        const vt = ticketsToCancel.find(t => t.ventanaId === vtId)?.ventana;
        await recalculateMonthlyClosingForDimension(monthStr, 'ventana', vtId, undefined, vt?.bancaId || undefined);
      }
      for (const bId of affectedBancas) {
        await recalculateMonthlyClosingForDimension(monthStr, 'banca', undefined, undefined, bId);
      }
    }

    // E. Registro en ActivityLog
    await ActivityService.log({
      action: ActivityType.SYSTEM_ACTION,
      targetType: 'TICKET',
      bancaId: affectedBancas[0] || null,
      details: {
        source: 'OPS_CLI',
        module: 'CANCEL_TICKETS_BY_CONSECUTIVE',
        cancelledCount: ticketsToCancel.length,
        ticketNumbers: ticketsToCancel.map(t => t.ticketNumber),
        totalAmountCancelled: ticketsToCancel.reduce((sum, t) => sum + Number(t.totalAmount || 0), 0),
        totalPayoutCancelled: ticketsToCancel.reduce((sum, t) => sum + Number(t.totalPayout || 0), 0),
        reason,
        affectedDates: affectedBusinessDates,
        executedBy: 'SUPER_ADMIN'
      }
    });

    const resultCancelled = ticketsToCancel.map(t => ({
      id: t.id,
      ticketNumber: t.ticketNumber,
      totalAmount: Number(t.totalAmount || 0),
      totalPayout: Number(t.totalPayout || 0),
      wasWinner: t.isWinner,
      sorteoName: t.sorteo.name,
      vendedorName: t.vendedor.name,
      bancaName: t.banca?.name || 'Global',
      businessDate: t.businessDate ? tz.toDateStr(t.businessDate) : tz.toDateStr(t.createdAt)
    }));

    return {
      success: true,
      cancelledTickets: resultCancelled,
      skippedTickets,
      datesResynced: datesToSync,
      bancasAffected: affectedBancas,
      message: `Se anularon ${resultCancelled.length} ticket(s) exitosamente y se resincronizó el arrastre de saldos hasta hoy.`
    };
  }
}
