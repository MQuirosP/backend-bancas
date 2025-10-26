// src/api/v1/services/venta.service.extended.ts
/**
 * Extensiones del servicio de ventas para funcionalidades avanzadas:
 * - Facets (valores válidos para filtros)
 * - Comparación de timeseries
 * - Reconciliación ventas vs pagos
 * - Detección de anomalías
 */

import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import { Prisma } from "@prisma/client";
import { buildWhereClause } from "./venta.service.helpers";

export const VentasServiceExtended = {
  /**
   * Facets - Valores válidos para filtros dinámicos
   * GET /ventas/facets
   */
  async facets(filters: any = {}): Promise<{
    ventanas: Array<{ id: string; name: string; code: string }>;
    vendedores: Array<{ id: string; name: string; username: string }>;
    loterias: Array<{ id: string; name: string }>;
    sorteos: Array<{ id: string; name: string; scheduledAt: string }>;
  }> {
    const where = buildWhereClause(filters);

    // Obtener IDs únicos de las entidades relacionadas
    const [ventanaIds, vendedorIds, loteriaIds, sorteoIds] = await Promise.all([
      prisma.ticket
        .findMany({
          where,
          select: { ventanaId: true },
          distinct: ["ventanaId"],
        })
        .then((r) => r.map((t) => t.ventanaId)),

      prisma.ticket
        .findMany({
          where,
          select: { vendedorId: true },
          distinct: ["vendedorId"],
        })
        .then((r) => r.map((t) => t.vendedorId)),

      prisma.ticket
        .findMany({
          where,
          select: { loteriaId: true },
          distinct: ["loteriaId"],
        })
        .then((r) => r.map((t) => t.loteriaId)),

      prisma.ticket
        .findMany({
          where,
          select: { sorteoId: true },
          distinct: ["sorteoId"],
        })
        .then((r) => r.map((t) => t.sorteoId)),
    ]);

    // Obtener detalles de cada entidad en paralelo
    const [ventanas, vendedores, loterias, sorteos] = await Promise.all([
      prisma.ventana.findMany({
        where: { id: { in: ventanaIds }, isActive: true },
        select: { id: true, name: true, code: true },
        orderBy: { name: "asc" },
      }),

      prisma.user.findMany({
        where: { id: { in: vendedorIds }, isActive: true },
        select: { id: true, name: true, username: true },
        orderBy: { name: "asc" },
      }),

      prisma.loteria.findMany({
        where: { id: { in: loteriaIds }, isActive: true },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),

      prisma.sorteo.findMany({
        where: { id: { in: sorteoIds }, isActive: true },
        select: { id: true, name: true, scheduledAt: true },
        orderBy: { scheduledAt: "desc" },
        take: 50, // Limitar sorteos a los últimos 50
      }),
    ]);

    return {
      ventanas,
      vendedores,
      loterias,
      sorteos: sorteos.map((s) => ({
        ...s,
        scheduledAt: s.scheduledAt.toISOString(),
      })),
    };
  },

  /**
   * Timeseries comparativa
   * GET /ventas/timeseries?compare=prev_period|prev_year
   */
  async timeseriesCompare(
    granularity: "hour" | "day" | "week",
    filters: any,
    compare?: "prev_period" | "prev_year"
  ): Promise<{
    current: Array<{ ts: string; ventasTotal: number; ticketsCount: number }>;
    comparison?: Array<{ ts: string; ventasTotal: number; ticketsCount: number }>;
  }> {
    if (!compare) {
      // Sin comparación, delegar al servicio base
      const { VentasService } = await import("./venta.service");
      const current = await VentasService.timeseries(granularity, filters);
      return { current };
    }

    const { dateFrom, dateTo } = filters;
    if (!dateFrom || !dateTo) {
      throw new AppError("Para comparación se requiere dateFrom y dateTo", 400);
    }

    // Calcular rango de comparación
    const from = new Date(dateFrom);
    const to = new Date(dateTo);
    const diffMs = to.getTime() - from.getTime();

    let comparisonFrom: Date;
    let comparisonTo: Date;

    if (compare === "prev_period") {
      comparisonTo = new Date(from.getTime() - 1);
      comparisonFrom = new Date(comparisonTo.getTime() - diffMs);
    } else {
      // prev_year
      comparisonFrom = new Date(from);
      comparisonFrom.setFullYear(from.getFullYear() - 1);
      comparisonTo = new Date(to);
      comparisonTo.setFullYear(to.getFullYear() - 1);
    }

    // Ejecutar ambas queries en paralelo
    const { VentasService } = await import("./venta.service");
    const [current, comparison] = await Promise.all([
      VentasService.timeseries(granularity, filters),
      VentasService.timeseries(granularity, {
        ...filters,
        dateFrom: comparisonFrom,
        dateTo: comparisonTo,
      }),
    ]);

    return { current, comparison };
  },

  /**
   * Reconciliación ventas vs pagos
   * GET /ventas/reconciliation
   */
  async reconciliation(filters: any): Promise<{
    summary: {
      totalVentas: number;
      totalPagos: number;
      diferencia: number;
      ticketsSinPago: number;
      ticketsPagoParcial: number;
    };
    ticketsSinPago: Array<{ id: string; ticketNumber: number; totalAmount: number; isWinner: boolean }>;
    ticketsPagoParcial: Array<{
      id: string;
      ticketNumber: number;
      totalAmount: number;
      totalPagado: number;
      pendiente: number;
    }>;
  }> {
    const where = buildWhereClause(filters);

    // Agregar filtro para solo tickets ganadores (los que deberían tener pago)
    const whereGanadores = { ...where, isWinner: true };

    // Obtener todos los tickets ganadores
    const ticketsGanadores = await prisma.ticket.findMany({
      where: whereGanadores,
      select: {
        id: true,
        ticketNumber: true,
        totalAmount: true,
        isWinner: true,
        jugadas: {
          select: { payout: true },
        },
      },
    });

    // Obtener pagos realizados
    const pagos = await prisma.ticketPayment.findMany({
      where: {
        ticket: whereGanadores,
        isReversed: false,
      },
      select: {
        ticketId: true,
        amountPaid: true,
      },
    });

    // Mapear pagos por ticket
    const pagosPorTicket = new Map<string, number>();
    pagos.forEach((p) => {
      pagosPorTicket.set(p.ticketId, (pagosPorTicket.get(p.ticketId) ?? 0) + p.amountPaid);
    });

    // Analizar cada ticket
    const ticketsSinPago: any[] = [];
    const ticketsPagoParcial: any[] = [];
    let totalVentas = 0;
    let totalPagos = 0;

    for (const ticket of ticketsGanadores) {
      const payoutEsperado = ticket.jugadas.reduce((sum, j) => sum + (j.payout ?? 0), 0);
      const totalPagado = pagosPorTicket.get(ticket.id) ?? 0;

      totalVentas += payoutEsperado;
      totalPagos += totalPagado;

      if (totalPagado === 0 && payoutEsperado > 0) {
        ticketsSinPago.push({
          id: ticket.id,
          ticketNumber: ticket.ticketNumber,
          totalAmount: ticket.totalAmount,
          isWinner: ticket.isWinner,
          payoutEsperado,
        });
      } else if (totalPagado > 0 && totalPagado < payoutEsperado) {
        ticketsPagoParcial.push({
          id: ticket.id,
          ticketNumber: ticket.ticketNumber,
          totalAmount: ticket.totalAmount,
          totalPagado,
          pendiente: payoutEsperado - totalPagado,
        });
      }
    }

    return {
      summary: {
        totalVentas,
        totalPagos,
        diferencia: totalVentas - totalPagos,
        ticketsSinPago: ticketsSinPago.length,
        ticketsPagoParcial: ticketsPagoParcial.length,
      },
      ticketsSinPago: ticketsSinPago.slice(0, 100), // Limitar a 100
      ticketsPagoParcial: ticketsPagoParcial.slice(0, 100),
    };
  },

  /**
   * Detección de anomalías usando Z-score
   * GET /ventas/anomalies?dimension=ventana&threshold=2
   */
  async anomalies(
    dimension: "ventana" | "vendedor" | "loteria" | "sorteo",
    filters: any,
    threshold = 2
  ): Promise<{
    summary: { mean: number; stdDev: number; threshold: number };
    anomalies: Array<{
      key: string;
      name: string;
      value: number;
      zScore: number;
      isOutlier: boolean;
    }>;
  }> {
    // Obtener breakdown de ventas por dimensión
    const { VentasService } = await import("./venta.service");
    const breakdown = await VentasService.breakdown(dimension, 1000, filters); // Sin límite para cálculo estadístico

    if (breakdown.length === 0) {
      return {
        summary: { mean: 0, stdDev: 0, threshold },
        anomalies: [],
      };
    }

    // Calcular media y desviación estándar
    const values = breakdown.map((item) => item.ventasTotal);
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);

    // Calcular Z-score para cada elemento
    const anomalies = breakdown
      .map((item) => {
        const zScore = stdDev === 0 ? 0 : (item.ventasTotal - mean) / stdDev;
        return {
          key: item.key,
          name: item.name,
          value: item.ventasTotal,
          zScore: Math.abs(zScore),
          isOutlier: Math.abs(zScore) > threshold,
        };
      })
      .filter((item) => item.isOutlier)
      .sort((a, b) => b.zScore - a.zScore);

    return {
      summary: { mean, stdDev, threshold },
      anomalies,
    };
  },
};

export default VentasServiceExtended;
