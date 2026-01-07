import { Prisma } from "@prisma/client";
import prisma from "../../core/prismaClient";
import logger from "../../core/logger";
import { CommissionSnapshot } from "./types/CommissionTypes";

/**
 * Filtros para leer snapshots
 */
export interface CommissionSnapshotFilters {
  ticketIds?: string[];
  ventanaId?: string;
  vendedorId?: string;
  bancaId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  sorteoId?: string;
  loteriaId?: string;
}

/**
 * Resultado de snapshot con información del ticket
 */
export interface SnapshotWithTicket {
  ticketId: string;
  jugadaId: string;
  snapshot: CommissionSnapshot;
  listeroSnapshot: CommissionSnapshot;
  amount: number;
  loteriaId: string;
  ventanaId: string;
  vendedorId: string | null;
}

/**
 * Servicio para manejar snapshots de comisiones guardados en BD
 * Los snapshots son inmutables y representan el estado de las comisiones al momento de crear el ticket
 */
export class CommissionSnapshotService {
  /**
   * Lee snapshots de comisiones para tickets específicos
   * Retorna un Map con ticketId como clave y array de snapshots como valor
   */
  async getSnapshotsForTickets(
    ticketIds: string[]
  ): Promise<Map<string, SnapshotWithTicket[]>> {
    if (ticketIds.length === 0) {
      return new Map();
    }

    const jugadas = await prisma.jugada.findMany({
      where: {
        ticketId: { in: ticketIds },
        deletedAt: null,
      },
      select: {
        id: true,
        ticketId: true,
        amount: true,
        commissionAmount: true,
        commissionPercent: true,
        commissionOrigin: true,
        commissionRuleId: true,
        listeroCommissionAmount: true,
        ticket: {
          select: {
            loteriaId: true,
            ventanaId: true,
            vendedorId: true,
          },
        },
      },
    });

    const result = new Map<string, SnapshotWithTicket[]>();

    for (const jugada of jugadas) {
      const snapshot: CommissionSnapshot = {
        commissionPercent: jugada.commissionPercent ?? 0,
        commissionAmount: jugada.commissionAmount ?? 0,
        commissionOrigin: (jugada.commissionOrigin as "USER" | "VENTANA" | "BANCA" | null) ?? null,
        commissionRuleId: jugada.commissionRuleId ?? null,
      };

      const listeroSnapshot: CommissionSnapshot = {
        commissionPercent: jugada.listeroCommissionAmount && jugada.amount > 0
          ? (jugada.listeroCommissionAmount / jugada.amount) * 100
          : 0,
        commissionAmount: jugada.listeroCommissionAmount ?? 0,
        commissionOrigin: jugada.listeroCommissionAmount && jugada.listeroCommissionAmount > 0
          ? "VENTANA" // Asumimos que viene de VENTANA/BANCA
          : null,
        commissionRuleId: null, // No guardamos ruleId para listero
      };

      const snapshotWithTicket: SnapshotWithTicket = {
        ticketId: jugada.ticketId,
        jugadaId: jugada.id,
        snapshot,
        listeroSnapshot,
        amount: jugada.amount,
        loteriaId: jugada.ticket.loteriaId,
        ventanaId: jugada.ticket.ventanaId,
        vendedorId: jugada.ticket.vendedorId,
      };

      const existing = result.get(jugada.ticketId) || [];
      existing.push(snapshotWithTicket);
      result.set(jugada.ticketId, existing);
    }

    return result;
  }

  /**
   * Lee snapshots de comisiones para un periodo específico
   * Usa filtros flexibles para diferentes casos de uso
   */
  async getSnapshotsForPeriod(
    filters: CommissionSnapshotFilters
  ): Promise<SnapshotWithTicket[]> {
    // Construir condiciones del ticket de forma incremental
    const ticketConditions: Prisma.TicketWhereInput = {
      deletedAt: null,
      isActive: true,
      status: { in: ["ACTIVE", "EVALUATED", "PAID", "PAGADO"] },
    };

    if (filters.ventanaId) {
      ticketConditions.ventanaId = filters.ventanaId;
    }

    if (filters.vendedorId) {
      ticketConditions.vendedorId = filters.vendedorId;
    }

    if (filters.bancaId) {
      ticketConditions.ventana = {
        bancaId: filters.bancaId,
      };
    }

    if (filters.sorteoId) {
      ticketConditions.sorteoId = filters.sorteoId;
    }

    if (filters.loteriaId) {
      ticketConditions.loteriaId = filters.loteriaId;
    }

    if (filters.dateFrom || filters.dateTo) {
      const dateFilter: Prisma.DateTimeFilter = {};
      if (filters.dateFrom) {
        dateFilter.gte = filters.dateFrom;
      }
      if (filters.dateTo) {
        dateFilter.lte = filters.dateTo;
      }
      ticketConditions.businessDate = dateFilter;
    }

    const whereConditions: Prisma.JugadaWhereInput = {
      deletedAt: null,
      ticket: ticketConditions,
    };

    if (filters.ticketIds && filters.ticketIds.length > 0) {
      whereConditions.ticketId = { in: filters.ticketIds };
    }

    const jugadas = await prisma.jugada.findMany({
      where: whereConditions,
      select: {
        id: true,
        ticketId: true,
        amount: true,
        commissionAmount: true,
        commissionPercent: true,
        commissionOrigin: true,
        commissionRuleId: true,
        listeroCommissionAmount: true,
        ticket: {
          select: {
            loteriaId: true,
            ventanaId: true,
            vendedorId: true,
          },
        },
      },
    });

    return jugadas.map((jugada) => {
      const snapshot: CommissionSnapshot = {
        commissionPercent: jugada.commissionPercent ?? 0,
        commissionAmount: jugada.commissionAmount ?? 0,
        commissionOrigin: (jugada.commissionOrigin as "USER" | "VENTANA" | "BANCA" | null) ?? null,
        commissionRuleId: jugada.commissionRuleId ?? null,
      };

      const listeroSnapshot: CommissionSnapshot = {
        commissionPercent: jugada.listeroCommissionAmount && jugada.amount > 0
          ? (jugada.listeroCommissionAmount / jugada.amount) * 100
          : 0,
        commissionAmount: jugada.listeroCommissionAmount ?? 0,
        commissionOrigin: jugada.listeroCommissionAmount && jugada.listeroCommissionAmount > 0
          ? "VENTANA"
          : null,
        commissionRuleId: null,
      };

      return {
        ticketId: jugada.ticketId,
        jugadaId: jugada.id,
        snapshot,
        listeroSnapshot,
        amount: jugada.amount,
        loteriaId: jugada.ticket.loteriaId,
        ventanaId: jugada.ticket.ventanaId,
        vendedorId: jugada.ticket.vendedorId,
      };
    });
  }

  /**
   * Valida consistencia de snapshots para tickets específicos
   * Verifica que los snapshots existan y sean válidos
   */
  async validateSnapshots(
    ticketIds: string[]
  ): Promise<{
    valid: boolean;
    missingSnapshots: string[];
    invalidSnapshots: Array<{ ticketId: string; jugadaId: string; reason: string }>;
  }> {
    const snapshots = await this.getSnapshotsForTickets(ticketIds);
    const missingSnapshots: string[] = [];
    const invalidSnapshots: Array<{ ticketId: string; jugadaId: string; reason: string }> = [];

    for (const ticketId of ticketIds) {
      const ticketSnapshots = snapshots.get(ticketId);
      if (!ticketSnapshots || ticketSnapshots.length === 0) {
        missingSnapshots.push(ticketId);
      } else {
        for (const snap of ticketSnapshots) {
          // Validar que commissionAmount sea consistente con commissionPercent
          const expectedAmount = (snap.amount * snap.snapshot.commissionPercent) / 100;
          const tolerance = 0.01; // Tolerancia de 1 centavo
          if (Math.abs(snap.snapshot.commissionAmount - expectedAmount) > tolerance) {
            invalidSnapshots.push({
              ticketId,
              jugadaId: snap.jugadaId,
              reason: `Commission amount mismatch: expected ${expectedAmount.toFixed(2)}, got ${snap.snapshot.commissionAmount.toFixed(2)}`,
            });
          }
        }
      }
    }

    return {
      valid: missingSnapshots.length === 0 && invalidSnapshots.length === 0,
      missingSnapshots,
      invalidSnapshots,
    };
  }

  /**
   * Recalcula snapshots para tickets específicos (solo para casos especiales)
   * Útil para migración o corrección de datos
   * ️ ADVERTENCIA: Esto puede cambiar valores históricos
   */
  async recalculateSnapshots(
    ticketIds: string[],
    context: {
      userPolicyJson: any;
      ventanaPolicyJson: any;
      bancaPolicyJson: any;
      listeroPolicyJson?: any;
    }
  ): Promise<Map<string, SnapshotWithTicket[]>> {
    // Esta función debería usar CommissionService para recalcular
    // Por ahora, solo retornamos los snapshots actuales
    // TODO: Implementar recálculo completo cuando sea necesario
    logger.warn({
      layer: "service",
      action: "RECALCULATE_SNAPSHOTS_NOT_IMPLEMENTED",
      payload: { ticketIds, note: "Recalculation not yet implemented" },
    });

    return this.getSnapshotsForTickets(ticketIds);
  }

  /**
   * Agrega snapshots por ventana
   */
  async aggregateSnapshotsByVentana(
    filters: CommissionSnapshotFilters
  ): Promise<Map<string, { totalCommission: number; totalListeroCommission: number; totalSales: number }>> {
    const snapshots = await this.getSnapshotsForPeriod(filters);
    const result = new Map<string, { totalCommission: number; totalListeroCommission: number; totalSales: number }>();

    for (const snap of snapshots) {
      const existing = result.get(snap.ventanaId) || {
        totalCommission: 0,
        totalListeroCommission: 0,
        totalSales: 0,
      };

      existing.totalCommission += snap.snapshot.commissionAmount;
      existing.totalListeroCommission += snap.listeroSnapshot.commissionAmount;
      existing.totalSales += snap.amount;

      result.set(snap.ventanaId, existing);
    }

    return result;
  }

  /**
   * Agrega snapshots por vendedor
   */
  async aggregateSnapshotsByVendedor(
    filters: CommissionSnapshotFilters
  ): Promise<Map<string, { totalCommission: number; totalListeroCommission: number; totalSales: number }>> {
    const snapshots = await this.getSnapshotsForPeriod(filters);
    const result = new Map<string, { totalCommission: number; totalListeroCommission: number; totalSales: number }>();

    for (const snap of snapshots) {
      if (!snap.vendedorId) continue;

      const existing = result.get(snap.vendedorId) || {
        totalCommission: 0,
        totalListeroCommission: 0,
        totalSales: 0,
      };

      existing.totalCommission += snap.snapshot.commissionAmount;
      existing.totalListeroCommission += snap.listeroSnapshot.commissionAmount;
      existing.totalSales += snap.amount;

      result.set(snap.vendedorId, existing);
    }

    return result;
  }
}

// Instancia singleton para uso directo
export const commissionSnapshotService = new CommissionSnapshotService();

