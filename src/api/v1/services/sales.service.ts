// src/api/v1/services/sales.service.ts
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import { getCRLocalComponents } from "../../../utils/businessDate";
import { getCRDayRangeUTC } from "../../../utils/businessDate";

export interface DailySalesStatsParams {
  vendedorId?: string;
  ventanaId?: string;
  bancaId?: string;
  date?: string; // YYYY-MM-DD, por defecto hoy
}

export interface DailySalesStatsResult {
  totalSales: number;
  vendedorId?: string;
  ventanaId?: string;
  bancaId?: string;
  date: string;
  ticketCount: number;
  currency: string;
}

export const SalesService = {
  /**
   * Obtiene las ventas del día para un vendedor, ventana o banca
   * Usa businessDate si está disponible, sino usa createdAt con rango CR
   */
  async getDailyStats(params: DailySalesStatsParams): Promise<DailySalesStatsResult> {
    const { vendedorId, ventanaId, bancaId, date } = params;

    // Determinar la fecha a usar (por defecto hoy en CR)
    let targetDate: Date;
    let dateStr: string;

    if (date) {
      // Parsear fecha YYYY-MM-DD
      const parsed = new Date(date + "T00:00:00Z");
      if (isNaN(parsed.getTime())) {
        throw new AppError("Formato de fecha inválido. Use YYYY-MM-DD", 400);
      }
      targetDate = parsed;
      dateStr = date;
    } else {
      // Usar fecha actual en CR
      const now = new Date();
      const crComponents = getCRLocalComponents(now);
      dateStr = `${crComponents.year}-${String(crComponents.month).padStart(2, "0")}-${String(crComponents.day).padStart(2, "0")}`;
      targetDate = now;
    }

    // Obtener rango del día en CR timezone
    const { fromAt, toAtExclusive } = getCRDayRangeUTC(targetDate);

    // Construir WHERE clause
    const where: any = {
      deletedAt: null, // Solo tickets no eliminados
      OR: [
        // Tickets con businessDate
        {
          businessDate: {
            gte: fromAt,
            lt: toAtExclusive,
          },
        },
        // Tickets sin businessDate (usar createdAt)
        {
          businessDate: null,
          createdAt: {
            gte: fromAt,
            lt: toAtExclusive,
          },
        },
      ],
    };

    // Aplicar filtros de scope
    if (vendedorId) {
      where.vendedorId = vendedorId;
    }
    if (ventanaId) {
      where.ventanaId = ventanaId;
    }
    if (bancaId) {
      // Necesitamos obtener ventanas de la banca primero
      const ventanas = await prisma.ventana.findMany({
        where: { bancaId, deletedAt: null },
        select: { id: true },
      });
      where.ventanaId = { in: ventanas.map((v) => v.id) };
    }

    // Calcular totales
    const [totalResult, countResult] = await Promise.all([
      prisma.ticket.aggregate({
        where,
        _sum: {
          totalAmount: true,
        },
      }),
      prisma.ticket.count({ where }),
    ]);

    return {
      totalSales: Number(totalResult._sum.totalAmount) || 0,
      vendedorId: vendedorId || undefined,
      ventanaId: ventanaId || undefined,
      bancaId: bancaId || undefined,
      date: dateStr,
      ticketCount: countResult,
      currency: "CRC",
    };
  },
};

