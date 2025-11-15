// src/modules/sorteos/services/sorteo.service.ts
import { ActivityType, Prisma, SorteoStatus } from "@prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import ActivityService from "../../../core/activity.service";
import SorteoRepository from "../../../repositories/sorteo.repository";
import {
  CreateSorteoDTO,
  EvaluateSorteoDTO,
  UpdateSorteoDTO,
} from "../dto/sorteo.dto";
import { formatIsoLocal } from "../../../utils/datetime";
import { resolveDateRange } from "../../../utils/dateRange";
import logger from "../../../core/logger";

const FINAL_STATES: Set<SorteoStatus> = new Set([
  SorteoStatus.EVALUATED,
  SorteoStatus.CLOSED,
]);
const EVALUABLE_STATES = new Set<SorteoStatus>([SorteoStatus.OPEN]);

function extractReventadoEnabled(loteria: any): boolean {
  if (!loteria || typeof loteria !== "object") return false;
  const rules = (loteria as any)?.rulesJson;
  if (!rules || typeof rules !== "object") return false;
  try {
    return Boolean((rules as any)?.reventadoConfig?.enabled);
  } catch {
    return false;
  }
}

function sanitizeLoteria(loteria: any) {
  if (!loteria || typeof loteria !== "object") return loteria;
  const { rulesJson, ...rest } = loteria;
  return rest;
}

function serializeSorteo<T extends { scheduledAt?: Date | null; loteria?: any }>(sorteo: T) {
  if (!sorteo) return sorteo;
  const reventadoEnabled = extractReventadoEnabled(sorteo.loteria);
  const serialized = {
    ...sorteo,
    scheduledAt: sorteo.scheduledAt ? formatIsoLocal(sorteo.scheduledAt) : null,
    reventadoEnabled,
  };
  if (sorteo.loteria) {
    (serialized as any).loteria = sanitizeLoteria(sorteo.loteria);
  }
  return serialized;
}

function serializeSorteos<T extends { scheduledAt?: Date | null }>(sorteos: T[]) {
  return sorteos.map((s) => serializeSorteo(s));
}

/**
 * Formatea una hora en formato 12h con AM/PM
 * Ejemplo: "14:30" → "2:30PM", "09:15" → "9:15AM"
 */
function formatTime12h(date: Date): string {
  const local = new Date(date.getTime() - 6 * 60 * 60 * 1000); // Convertir a CR time
  let hours = local.getUTCHours();
  const minutes = local.getUTCMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12; // 0 debe ser 12
  const minutesStr = String(minutes).padStart(2, '0');
  return `${hours}:${minutesStr}${ampm}`;
}

/**
 * Extrae la fecha en formato YYYY-MM-DD de un Date
 */
function formatDateOnly(date: Date): string {
  const local = new Date(date.getTime() - 6 * 60 * 60 * 1000); // Convertir a CR time
  const year = local.getUTCFullYear();
  const month = String(local.getUTCMonth() + 1).padStart(2, '0');
  const day = String(local.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export const SorteoService = {
  async create(data: CreateSorteoDTO, userId: string) {
    const loteria = await prisma.loteria.findUnique({
      where: { id: data.loteriaId },
      select: { id: true, isActive: true },
    });
    if (!loteria || !loteria.isActive)
      throw new AppError("Lotería no encontrada", 404);

    const s = await SorteoRepository.create(data);

    const details: Prisma.InputJsonObject = {
      loteriaId: data.loteriaId,
      scheduledAt: (data.scheduledAt instanceof Date
        ? data.scheduledAt
        : new Date(data.scheduledAt)
      ).toISOString(),
    };

    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_CREATE,
      targetType: "SORTEO",
      targetId: s.id,
      details,
    });

    return serializeSorteo(s);
  },

  async update(id: string, data: UpdateSorteoDTO, userId: string) {
    const existing = await SorteoRepository.findById(id);
    if (!existing) throw new AppError("Sorteo no encontrado", 404);
    if (FINAL_STATES.has(existing.status)) {
      throw new AppError("No se puede editar un sorteo evaluado o cerrado", 409);
    }

    // Validar cambio de lotería solo desde SCHEDULED
    if (data.loteriaId && data.loteriaId !== existing.loteriaId) {
      if (existing.status !== "SCHEDULED") {
        throw new AppError("Solo se puede cambiar la lotería en estado SCHEDULED", 409);
      }
      const loteria = await prisma.loteria.findUnique({ where: { id: data.loteriaId }, select: { id: true, isActive: true } });
      if (!loteria || !loteria.isActive) throw new AppError("Lotería no encontrada", 404);
    }

    const s = await SorteoRepository.update(id, {
      name: data.name,
      loteriaId: data.loteriaId,
      scheduledAt: data.scheduledAt,
      isActive: data.isActive,
    } as UpdateSorteoDTO);

    const details: Record<string, any> = {};
    if (data.name && data.name !== existing.name) details.name = data.name;
    if (data.loteriaId && data.loteriaId !== existing.loteriaId) details.loteriaId = data.loteriaId;
    if (data.scheduledAt) {
      details.scheduledAt = (
        data.scheduledAt instanceof Date ? data.scheduledAt : new Date(data.scheduledAt)
      ).toISOString();
    }
    if (data.isActive !== undefined && data.isActive !== (existing as any).isActive) {
      details.isActive = data.isActive;
    }

    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_UPDATE,
      targetType: "SORTEO",
      targetId: id,
      details,
    });

    return serializeSorteo(s);
  },

  async open(id: string, userId: string) {
    const existing = await SorteoRepository.findById(id);
    if (!existing) throw new AppError("Sorteo no encontrado", 404);
    if (existing.status !== SorteoStatus.SCHEDULED) {
      throw new AppError("Solo se puede abrir desde SCHEDULED", 409);
    }

    const s = await SorteoRepository.open(id);

    const details: Prisma.InputJsonObject = {
      from: existing.status,
      to: SorteoStatus.OPEN,
    };

    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_OPEN,
      targetType: "SORTEO",
      targetId: id,
      details,
    });

    return serializeSorteo(s);
  },

  async close(id: string, userId: string) {
    const existing = await SorteoRepository.findById(id);
    if (!existing) throw new AppError("Sorteo no encontrado", 404);
    if (existing.status !== SorteoStatus.OPEN) {
      throw new AppError("Solo se puede cerrar desde OPEN", 409);
    }

    const s = await SorteoRepository.close(id);

    const details: Prisma.InputJsonObject = {
      from: existing.status,
      to: SorteoStatus.CLOSED,
    };

    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_CLOSE,
      targetType: "SORTEO",
      targetId: id,
      details,
    });

    return serializeSorteo(s);
  },

  async evaluate(id: string, body: EvaluateSorteoDTO, userId: string) {
    const {
      winningNumber,
      extraMultiplierId = null,
      extraOutcomeCode: extraOutcomeCodeInput = null,
    } = body;

    if (!winningNumber?.length)
      throw new AppError("winningNumber es requerido", 400);

    // 1) Cargar sorteo y validar estado
    const existing = await SorteoRepository.findById(id);
    if (!existing) throw new AppError("Sorteo no encontrado", 404);
    if (!EVALUABLE_STATES.has(existing.status)) {
      throw new AppError("Solo se puede evaluar desde OPEN", 409);
    }

    // 2) Resolver multiplicador extra (si viene) y etiqueta neutra
    // Si no viene extraMultiplierId, significa que no salió multiplicador → extraX = 0
    let extraX: number = 0;
    let extraOutcomeCode: string | null = null;

    if (extraMultiplierId) {
      const mul = await prisma.loteriaMultiplier.findUnique({
        where: { id: extraMultiplierId },
        select: {
          id: true,
          valueX: true,
          isActive: true,
          loteriaId: true,
          kind: true,
          name: true,
          appliesToSorteoId: true,
        },
      });

      if (!mul || !mul.isActive)
        throw new AppError("extraMultiplierId inválido o inactivo", 400);
      if (mul.loteriaId !== existing.loteriaId) {
        throw new AppError(
          "extraMultiplierId no pertenece a la lotería del sorteo",
          400
        );
      }
      if (mul.kind !== "REVENTADO") {
        throw new AppError("extraMultiplierId no es de tipo REVENTADO", 400);
      }
      if (mul.appliesToSorteoId && mul.appliesToSorteoId !== id) {
        throw new AppError("extraMultiplierId no aplica a este sorteo", 400);
      }

      extraX = mul.valueX;
      extraOutcomeCode = (extraOutcomeCodeInput ?? mul.name ?? null) || null;
    }

    // 3) Transacción
    const evaluationResult = await prisma.$transaction(async (tx) => {
      // 3.1 Snapshot del sorteo
      await tx.sorteo.update({
        where: { id },
        data: {
          status: "EVALUATED",
          winningNumber,
          extraOutcomeCode,
          ...(extraMultiplierId
            ? { extraMultiplier: { connect: { id: extraMultiplierId } } }
            : { extraMultiplier: { disconnect: true } }),
          extraMultiplierX: extraX,
        },
      });

      // 3.2 Pagar NUMERO
      const numeroWinners = await tx.jugada.findMany({
        where: {
          ticket: { sorteoId: id },
          type: "NUMERO",
          number: winningNumber,
          isActive: true,
        },
        select: {
          id: true,
          amount: true,
          finalMultiplierX: true,
          ticketId: true,
        },
      });

      for (const j of numeroWinners) {
        const payout = j.amount * j.finalMultiplierX;
        await tx.jugada.update({
          where: { id: j.id },
          data: { isWinner: true, payout },
        });
      }

      // 3.3 Pagar REVENTADO (y asignar multiplierId)
      // Solo paga si extraX > 0 (es decir, si salió multiplicador extra)
      let reventadoWinners: { id: string; amount: number; ticketId: string }[] = [];

      if (extraX > 0) {
        reventadoWinners = await tx.jugada.findMany({
          where: {
            ticket: { sorteoId: id },
            type: "REVENTADO",
            reventadoNumber: winningNumber,
            isActive: true,
          },
          select: { id: true, amount: true, ticketId: true },
        });

        for (const j of reventadoWinners) {
          const payout = j.amount * extraX;
          await tx.jugada.update({
            where: { id: j.id },
            data: {
              isWinner: true,
              finalMultiplierX: extraX, // snapshot a la jugada
              payout,
              ...(extraMultiplierId
                ? { multiplier: { connect: { id: extraMultiplierId } } }
                : {}),
            },
          });
        }
      }

      // 3.4 Marcar tickets y calcular totalPayout para ganadores
      const winningTicketIds = new Set<string>([
        ...numeroWinners.map((j) => j.ticketId),
        ...reventadoWinners.map((j) => j.ticketId),
      ]);

      const tickets = await tx.ticket.findMany({
        where: { sorteoId: id },
        select: { id: true },
      });

      let winners = 0;
      for (const t of tickets) {
        const tIsWinner = winningTicketIds.has(t.id);
        if (tIsWinner) winners++;
        
        // Si es ganador, calcular totalPayout sumando jugadas ganadoras
        let totalPayout = 0;
        let remainingAmount = 0;
        if (tIsWinner) {
          const winningJugadas = await tx.jugada.aggregate({
            where: { ticketId: t.id, isWinner: true },
            _sum: { payout: true },
          });
          totalPayout = winningJugadas._sum.payout || 0;
          remainingAmount = totalPayout; // Inicialmente todo pendiente
        }
        
        await tx.ticket.update({
          where: { id: t.id },
          data: { 
            status: "EVALUATED", 
            isWinner: tIsWinner,
            ...(tIsWinner ? { 
              totalPayout,
              totalPaid: 0,
              remainingAmount,
            } : {}),
          },
        });
      }

      await tx.sorteo.update({
        where: { id },
        data: {
          hasWinner: winningTicketIds.size > 0,
        },
      });

      // 3.5 Auditoría
      await tx.activityLog.create({
        data: {
          userId,
          action: "SORTEO_EVALUATE",
          targetType: "SORTEO",
          targetId: id,
          details: {
            winningNumber,
            extraMultiplierId,
            extraMultiplierX: extraX,
            extraOutcomeCode,
            winners,
          },
        },
      });

      return { winners, extraMultiplierX: extraX };
    });

    // 4) Log adicional
    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_EVALUATE,
      targetType: "SORTEO",
      targetId: id,
      details: {
        winningNumber,
        extraMultiplierId,
        extraMultiplierX: evaluationResult.extraMultiplierX,
        extraOutcomeCode,
        winners: evaluationResult.winners,
      },
    });

    // 5) Devolver sorteo evaluado (con include para mantener reventadoEnabled)
    const evaluated = await SorteoRepository.findById(id);
    return evaluated ? serializeSorteo(evaluated) : evaluated;
  },

  async remove(id: string, userId: string, reason?: string) {
    const s = await SorteoRepository.softDelete(id, userId, reason);

    const details: Record<string, any> = {};
    if (reason) details.reason = reason;

    await ActivityService.log({
      userId,
      action: ActivityType.SOFT_DELETE,
      targetType: "SORTEO",
      targetId: id,
      details: details as Prisma.InputJsonObject,
    });

    return serializeSorteo(s);
  },

  async revertEvaluation(id: string, userId: string, reason?: string) {
    const existing = await SorteoRepository.findById(id);
    if (!existing) throw new AppError("Sorteo no encontrado", 404);
    if (existing.status !== SorteoStatus.EVALUATED) {
      throw new AppError("Solo se puede revertir un sorteo evaluado", 409);
    }

    const reverted = await SorteoRepository.revertEvaluation(id);

    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_REOPEN,
      targetType: "SORTEO",
      targetId: id,
      details: {
        reason: reason ?? null,
        previousWinningNumber: existing.winningNumber,
        previousExtraMultiplierId: existing.extraMultiplierId,
      },
    });

    return serializeSorteo(reverted);
  },

  async list(params: {
    loteriaId?: string;
    page?: number;
    pageSize?: number;
    status?: SorteoStatus;
    search?: string;
    isActive?: boolean;
    dateFrom?: Date;
    dateTo?: Date;
    groupBy?: "hour" | "loteria-hour";
  }) {
    // Early return: sin groupBy, usar lógica existente
    if (!params.groupBy) {
      const p = params.page && params.page > 0 ? params.page : 1;
      const ps = params.pageSize && params.pageSize > 0 ? params.pageSize : 10;

      const { data, total } = await SorteoRepository.list({
        page: p,
        pageSize: ps,
        loteriaId: params.loteriaId,
        status: params.status,
        search: params.search?.trim() || undefined,
        isActive: params.isActive,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
      });

      const totalPages = Math.ceil(total / ps);
      return {
        data: serializeSorteos(data),
        meta: {
          total,
          page: p,
          pageSize: ps,
          totalPages,
          hasNextPage: p < totalPages,
          hasPrevPage: p > 1,
          grouped: false,
          groupBy: null,
        },
      };
    }

    // Con groupBy, usar query SQL optimizada
    if (params.groupBy === "loteria-hour") {
      return this.groupedByLoteriaHour(params);
    }

    if (params.groupBy === "hour") {
      return this.groupedByHour(params);
    }

    throw new AppError(`Unsupported groupBy: ${params.groupBy}`, 400);
  },

  /**
   * Agrupa sorteos por loteriaId + hora (extraída de scheduledAt)
   * Usa SQL GROUP BY para eficiencia
   */
  async groupedByLoteriaHour(params: {
    loteriaId?: string;
    status?: SorteoStatus;
    isActive?: boolean;
    dateFrom?: Date;
    dateTo?: Date;
  }) {
    // Construir condiciones WHERE
    const whereConditions: Prisma.Sql[] = [
      Prisma.sql`s."deletedAt" IS NULL`,
    ];

    if (params.loteriaId) {
      whereConditions.push(Prisma.sql`s."loteriaId" = ${params.loteriaId}::uuid`);
    }

    if (params.status) {
      whereConditions.push(Prisma.sql`s."status" = ${params.status}::text`);
    }

    if (params.isActive !== undefined) {
      whereConditions.push(Prisma.sql`s."isActive" = ${params.isActive}`);
    }

    if (params.dateFrom || params.dateTo) {
      if (params.dateFrom) {
        whereConditions.push(Prisma.sql`s."scheduledAt" >= ${params.dateFrom}`);
      }
      if (params.dateTo) {
        whereConditions.push(Prisma.sql`s."scheduledAt" <= ${params.dateTo}`);
      }
    }

    const whereClause = whereConditions.length
      ? Prisma.sql`WHERE ${Prisma.join(whereConditions, " AND ")}`
      : Prisma.empty;

    // Query SQL con GROUP BY (PostgreSQL)
    // Usar CTE para evitar problemas con GROUP BY en subquery
    const query = Prisma.sql`
      WITH grouped_sorteos AS (
        SELECT
          s."loteriaId",
          l.name as "loteriaName",
          TO_CHAR(
            s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
            'HH24:MI'
          ) as "hour24",
          TO_CHAR(
            s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
            'HH12:MI AM'
          ) as "hour12",
          COUNT(*)::int as count,
          MAX(s."scheduledAt") as "mostRecentDate",
          STRING_AGG(s.id::text, ',') as "sorteoIds"
        FROM "Sorteo" s
        INNER JOIN "Loteria" l ON l.id = s."loteriaId"
        ${whereClause}
        GROUP BY 
          s."loteriaId",
          l.name,
          TO_CHAR(
            s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
            'HH24:MI'
          )
      )
      SELECT
        gs."loteriaId",
        gs."loteriaName",
        gs."hour24",
        gs."hour12",
        gs.count,
        gs."mostRecentDate",
        gs."sorteoIds",
        (
          SELECT s2.id 
          FROM "Sorteo" s2 
          WHERE s2."loteriaId" = gs."loteriaId"
            AND s2."deletedAt" IS NULL
            AND TO_CHAR(
              s2."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
              'HH24:MI'
            ) = gs."hour24"
          ORDER BY s2."scheduledAt" DESC
          LIMIT 1
        ) as "mostRecentSorteoId"
      FROM grouped_sorteos gs
      ORDER BY 
        gs."loteriaName" ASC,
        gs."hour24" ASC
    `;

    const results = await prisma.$queryRaw<Array<{
      loteriaId: string;
      loteriaName: string;
      hour24: string;
      hour12: string;
      count: number;
      mostRecentDate: Date;
      sorteoIds: string;
      mostRecentSorteoId: string;
    }>>(query);

    // Formatear respuesta
    // Ordenar sorteoIds por fecha (obtener IDs ordenados por scheduledAt DESC)
    const data = await Promise.all(
      results.map(async (row) => {
        // Obtener IDs ordenados por fecha descendente
        const sorteoIdsArray = row.sorteoIds.split(",");
        const sorteosWithDates = await prisma.sorteo.findMany({
          where: {
            id: { in: sorteoIdsArray },
            ...(params.loteriaId ? { loteriaId: params.loteriaId } : {}),
          },
          select: {
            id: true,
            scheduledAt: true,
          },
          orderBy: {
            scheduledAt: "desc",
          },
        });
        const sortedIds = sorteosWithDates.map((s) => s.id);

        return {
          loteriaId: row.loteriaId,
          loteriaName: row.loteriaName,
          hour: row.hour12.trim(), // Formato 12h para display (trim para quitar espacios)
          hour24: row.hour24, // Formato 24h para ordenamiento
          sorteoIds: sortedIds, // Array ordenado por fecha descendente
          count: row.count,
          mostRecentSorteoId: row.mostRecentSorteoId,
          mostRecentDate: formatDateOnly(row.mostRecentDate),
        };
      })
    );

    return {
      data,
      meta: {
        total: data.length,
        grouped: true,
        groupBy: "loteria-hour",
        ...(params.dateFrom ? { fromDate: formatDateOnly(params.dateFrom) } : {}),
        ...(params.dateTo ? { toDate: formatDateOnly(params.dateTo) } : {}),
      },
    };
  },

  /**
   * Agrupa sorteos solo por hora (útil cuando ya se filtró por loteriaId)
   * Usa SQL GROUP BY para eficiencia
   */
  async groupedByHour(params: {
    loteriaId?: string;
    status?: SorteoStatus;
    isActive?: boolean;
    dateFrom?: Date;
    dateTo?: Date;
  }) {
    // Construir condiciones WHERE
    const whereConditions: Prisma.Sql[] = [
      Prisma.sql`s."deletedAt" IS NULL`,
    ];

    if (params.loteriaId) {
      whereConditions.push(Prisma.sql`s."loteriaId" = ${params.loteriaId}::uuid`);
    }

    if (params.status) {
      whereConditions.push(Prisma.sql`s."status" = ${params.status}::text`);
    }

    if (params.isActive !== undefined) {
      whereConditions.push(Prisma.sql`s."isActive" = ${params.isActive}`);
    }

    if (params.dateFrom || params.dateTo) {
      if (params.dateFrom) {
        whereConditions.push(Prisma.sql`s."scheduledAt" >= ${params.dateFrom}`);
      }
      if (params.dateTo) {
        whereConditions.push(Prisma.sql`s."scheduledAt" <= ${params.dateTo}`);
      }
    }

    const whereClause = whereConditions.length
      ? Prisma.sql`WHERE ${Prisma.join(whereConditions, " AND ")}`
      : Prisma.empty;

    // Query SQL con GROUP BY solo por hora (PostgreSQL)
    // Usar CTE para evitar problemas con GROUP BY en subquery
    const query = Prisma.sql`
      WITH grouped_sorteos AS (
        SELECT
          TO_CHAR(
            s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
            'HH24:MI'
          ) as "hour24",
          TO_CHAR(
            s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
            'HH12:MI AM'
          ) as "hour12",
          COUNT(*)::int as count,
          MAX(s."scheduledAt") as "mostRecentDate",
          STRING_AGG(s.id::text, ',') as "sorteoIds"
        FROM "Sorteo" s
        ${whereClause}
        GROUP BY 
          TO_CHAR(
            s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
            'HH24:MI'
          )
      )
      SELECT
        gs."hour24",
        gs."hour12",
        gs.count,
        gs."mostRecentDate",
        gs."sorteoIds",
        (
          SELECT s2.id 
          FROM "Sorteo" s2 
          WHERE s2."deletedAt" IS NULL
            AND TO_CHAR(
              s2."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
              'HH24:MI'
            ) = gs."hour24"
            ${params.loteriaId ? Prisma.sql`AND s2."loteriaId" = ${params.loteriaId}::uuid` : Prisma.empty}
          ORDER BY s2."scheduledAt" DESC
          LIMIT 1
        ) as "mostRecentSorteoId"
      FROM grouped_sorteos gs
      ORDER BY 
        gs."hour24" ASC
    `;

    const results = await prisma.$queryRaw<Array<{
      hour24: string;
      hour12: string;
      count: number;
      mostRecentDate: Date;
      sorteoIds: string;
      mostRecentSorteoId: string;
    }>>(query);

    // Formatear respuesta
    // Ordenar sorteoIds por fecha (obtener IDs ordenados por scheduledAt DESC)
    const data = await Promise.all(
      results.map(async (row) => {
        // Obtener IDs ordenados por fecha descendente
        const sorteoIdsArray = row.sorteoIds.split(",");
        const sorteosWithDates = await prisma.sorteo.findMany({
          where: {
            id: { in: sorteoIdsArray },
            ...(params.loteriaId ? { loteriaId: params.loteriaId } : {}),
          },
          select: {
            id: true,
            scheduledAt: true,
          },
          orderBy: {
            scheduledAt: "desc",
          },
        });
        const sortedIds = sorteosWithDates.map((s) => s.id);

        return {
          hour: row.hour12.trim(), // Formato 12h para display
          hour24: row.hour24, // Formato 24h para ordenamiento
          sorteoIds: sortedIds, // Array ordenado por fecha descendente
          count: row.count,
          mostRecentSorteoId: row.mostRecentSorteoId,
          mostRecentDate: formatDateOnly(row.mostRecentDate),
        };
      })
    );

    return {
      data,
      meta: {
        total: data.length,
        grouped: true,
        groupBy: "hour",
        ...(params.dateFrom ? { fromDate: formatDateOnly(params.dateFrom) } : {}),
        ...(params.dateTo ? { toDate: formatDateOnly(params.dateTo) } : {}),
      },
    };
  },

  async findById(id: string) {
    const sorteo = await SorteoRepository.findById(id);
    if (!sorteo) throw new AppError("Sorteo no encontrado", 404);
    return serializeSorteo(sorteo);
  },

  /**
   * Obtiene resumen de sorteos evaluados con datos financieros agregados
   * GET /api/v1/sorteos/evaluated-summary
   */
  async evaluatedSummary(
    params: {
      date?: string;
      fromDate?: string;
      toDate?: string;
      scope?: string;
      loteriaId?: string;
    },
    vendedorId: string
  ) {
    try {
      // Resolver rango de fechas
      const dateRange = resolveDateRange(
        params.date || "today",
        params.fromDate,
        params.toDate
      );

      // Construir filtro para sorteos EVALUATED
      const sorteoWhere: Prisma.SorteoWhereInput = {
        status: SorteoStatus.EVALUATED,
        scheduledAt: {
          gte: dateRange.fromAt,
          lte: dateRange.toAt,
        },
        ...(params.loteriaId ? { loteriaId: params.loteriaId } : {}),
        // Solo sorteos donde el vendedor tiene tickets
        tickets: {
          some: {
            vendedorId,
            deletedAt: null,
          },
        },
      };

      // Obtener sorteos evaluados ordenados por scheduledAt ASC (más antiguo primero)
      // para calcular el acumulado correctamente del más antiguo hacia el más reciente
      const sorteos = await prisma.sorteo.findMany({
        where: sorteoWhere,
        include: {
          loteria: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        orderBy: {
          scheduledAt: "asc", // ASC para calcular acumulado del más antiguo al más reciente
        },
      });

      // Obtener datos financieros agregados por sorteo
      const sorteoIds = sorteos.map((s) => s.id);
      
      // Agregar datos financieros por sorteo
      const financialData = await prisma.ticket.groupBy({
        by: ["sorteoId"],
        where: {
          sorteoId: { in: sorteoIds },
          vendedorId,
          deletedAt: null,
        },
        _sum: {
          totalAmount: true,
          totalCommission: true,
          totalPayout: true,
        },
        _count: {
          id: true,
        },
      });

      // Obtener conteos de tickets ganadores y pagados
      const winningTicketsData = await prisma.ticket.groupBy({
        by: ["sorteoId"],
        where: {
          sorteoId: { in: sorteoIds },
          vendedorId,
          isWinner: true,
          deletedAt: null,
        },
        _count: {
          id: true,
        },
      });

      const paidTicketsData = await prisma.ticket.groupBy({
        by: ["sorteoId"],
        where: {
          sorteoId: { in: sorteoIds },
          vendedorId,
          status: "PAID",
          deletedAt: null,
        },
        _count: {
          id: true,
        },
      });

      // Crear mapas para acceso rápido
      const financialMap = new Map(
        financialData.map((f) => [
          f.sorteoId,
          {
            totalSales: f._sum.totalAmount || 0,
            totalCommission: f._sum.totalCommission || 0,
            totalPrizes: f._sum.totalPayout || 0,
            ticketCount: f._count.id,
          },
        ])
      );

      const winningMap = new Map(
        winningTicketsData.map((w) => [w.sorteoId, w._count.id])
      );

      const paidMap = new Map(
        paidTicketsData.map((p) => [p.sorteoId, p._count.id])
      );

      // Construir respuesta con cálculos
      // IMPORTANTE: El acumulado se calcula del más antiguo hacia el más reciente
      // Los sorteos están ordenados por scheduledAt ASC (más antiguo primero) para el cálculo
      let accumulated = 0;
      const dataWithAccumulated = sorteos.map((sorteo) => {
        const financial = financialMap.get(sorteo.id) || {
          totalSales: 0,
          totalCommission: 0,
          totalPrizes: 0,
          ticketCount: 0,
        };

        // Calcular isReventado
        const isReventado =
          (sorteo.extraMultiplierId !== null &&
            sorteo.extraMultiplierId !== undefined) ||
          (sorteo.extraMultiplierX !== null &&
            sorteo.extraMultiplierX !== undefined &&
            sorteo.extraMultiplierX > 0);

        // Calcular subtotal
        const subtotal =
          financial.totalSales -
          financial.totalCommission -
          financial.totalPrizes;

        // Calcular accumulated: suma desde el más antiguo hacia el más reciente
        // accumulated[n] = subtotal[n] + accumulated[n-1], donde accumulated[0] = subtotal[0]
        // Esto representa el saldo acumulado desde el inicio hasta ese sorteo
        accumulated = accumulated + subtotal;

        const winningCount = winningMap.get(sorteo.id) || 0;
        const paidCount = paidMap.get(sorteo.id) || 0;
        const unpaidCount = winningCount - paidCount;

        return {
          sorteoId: sorteo.id,
          sorteoName: sorteo.name,
          scheduledAt: sorteo.scheduledAt, // Guardar Date para ordenar después
          date: formatDateOnly(sorteo.scheduledAt),
          time: formatTime12h(sorteo.scheduledAt),
          loteriaId: sorteo.loteriaId,
          loteriaName: sorteo.loteria?.name || "Desconocida",
          winningNumber: sorteo.winningNumber,
          isReventado,
          totalSales: financial.totalSales,
          totalCommission: financial.totalCommission,
          totalPrizes: financial.totalPrizes,
          ticketCount: financial.ticketCount,
          subtotal,
          accumulated,
          winningTicketsCount: winningCount,
          paidTicketsCount: paidCount,
          unpaidTicketsCount: unpaidCount,
        };
      });

      // Ordenar por scheduledAt DESC (más reciente primero) para la respuesta
      // pero manteniendo el acumulado ya calculado correctamente
      const data = dataWithAccumulated
        .sort((a, b) => new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime())
        .map((item) => ({
          ...item,
          scheduledAt: formatIsoLocal(item.scheduledAt), // Formatear después de ordenar
        }));

      // Calcular totales agregados
      const totals = {
        totalSales: data.reduce((sum, s) => sum + s.totalSales, 0),
        totalCommission: data.reduce((sum, s) => sum + s.totalCommission, 0),
        totalPrizes: data.reduce((sum, s) => sum + s.totalPrizes, 0),
        totalSubtotal: data.reduce((sum, s) => sum + s.subtotal, 0),
        totalTickets: data.reduce((sum, s) => sum + s.ticketCount, 0),
      };

      return {
        data,
        meta: {
          totals,
          dateFilter: params.date || "today",
          ...(params.fromDate ? { fromDate: params.fromDate } : {}),
          ...(params.toDate ? { toDate: params.toDate } : {}),
          totalSorteos: sorteos.length,
        },
      };
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "SORTEO_EVALUATED_SUMMARY_FAIL",
        payload: { message: err.message, params },
      });
      throw err;
    }
  },
};

export default SorteoService;
