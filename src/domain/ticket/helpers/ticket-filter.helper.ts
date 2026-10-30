import { Prisma, TicketStatus, BetType } from "../../../generated/prisma/client";

/**
 * Helper function for building dynamic WHERE and JOIN clauses consistently for ticket queries
 */
export function buildTicketFilterClause(
  params: any,
  effectiveFilters: any,
  dateFrom: Date | undefined,
  dateTo: Date | undefined,
  isNumbersSummary: boolean,
): Prisma.Sql {
  const sqlJoins: Prisma.Sql[] = [];
  if (params.sorteoStatus) {
    sqlJoins.push(Prisma.sql`INNER JOIN "Sorteo" s ON t."sorteoId" = s.id`);
  }
  if (isNumbersSummary && effectiveFilters.bancaId) {
    sqlJoins.push(Prisma.sql`INNER JOIN "Ventana" v ON t."ventanaId" = v.id`);
  }
  const joinsSQL =
    sqlJoins.length > 0 ? Prisma.join(sqlJoins, " ") : Prisma.empty;

  const sqlConditions: Prisma.Sql[] = [];

  if (params.status === TicketStatus.CANCELLED) {
    sqlConditions.push(Prisma.sql`t."status" = ${TicketStatus.CANCELLED}::"TicketStatus"`);
  } else {
    sqlConditions.push(Prisma.sql`t."deletedAt" IS NULL`);
    sqlConditions.push(Prisma.sql`t."isActive" = true`);
    sqlConditions.push(Prisma.sql`t."status" <> ${TicketStatus.CANCELLED}::"TicketStatus"`);
  }

  if (params.sorteoStatus) {
    sqlConditions.push(Prisma.sql`s.status::text = ${params.sorteoStatus}`);
  }

  if (effectiveFilters.bancaId) {
    if (isNumbersSummary) {
      sqlConditions.push(
        Prisma.sql`v."bancaId" = CAST(${effectiveFilters.bancaId} AS uuid)`,
      );
    } else {
      sqlConditions.push(
        Prisma.sql`t."bancaId" = CAST(${effectiveFilters.bancaId} AS uuid)`,
      );
    }
  }
  if (effectiveFilters.vendedorId) {
    sqlConditions.push(
      Prisma.sql`t."vendedorId" = CAST(${effectiveFilters.vendedorId} AS uuid)`,
    );
  }
  if (effectiveFilters.ventanaId) {
    sqlConditions.push(
      Prisma.sql`t."ventanaId" = CAST(${effectiveFilters.ventanaId} AS uuid)`,
    );
  }

  if (dateFrom) {
    const fromStr = dateFrom.toISOString().split("T")[0];
    sqlConditions.push(
      Prisma.sql`t."businessDate" >= CAST(${fromStr} AS DATE)`,
    );
  }
  if (dateTo) {
    const toStr = dateTo.toISOString().split("T")[0];
    sqlConditions.push(Prisma.sql`t."businessDate" <= CAST(${toStr} AS DATE)`);
  }

  if (params.loteriaId && params.loteriaId !== "all") {
    sqlConditions.push(
      Prisma.sql`t."loteriaId" = CAST(${params.loteriaId} AS uuid)`,
    );
  }
  if (params.sorteoId && params.sorteoId !== "all") {
    sqlConditions.push(
      Prisma.sql`t."sorteoId" = CAST(${params.sorteoId} AS uuid)`,
    );
  }
  if (params.status && params.status !== "all") {
    if (params.status === "WINNERS_PENDING") {
      sqlConditions.push(Prisma.sql`t."isWinner" = true`);
      sqlConditions.push(Prisma.sql`t.status::text = ${TicketStatus.EVALUATED}`);
    } else {
      sqlConditions.push(Prisma.sql`t.status::text = ${params.status}`);
    }
  }
  if (params.multiplierId && params.multiplierId !== "all") {
    sqlConditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "Jugada" jf
      WHERE jf."ticketId" = t.id
        AND jf."multiplierId" = CAST(${params.multiplierId} AS uuid)
        AND jf."deletedAt" IS NULL
        AND jf."isActive" = true
        AND jf.type::text = ${BetType.NUMERO}
    )`);
  }

  const whereSQL =
    sqlConditions.length > 0
      ? Prisma.join(sqlConditions, " AND ")
      : Prisma.empty;

  return Prisma.sql`
    ${joinsSQL}
    WHERE ${whereSQL}
  `;
}
