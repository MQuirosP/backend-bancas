import 'dotenv/config';
import { formatCRC } from './helpers';
import prisma from '../../core/prismaClient';
import { Prisma } from '../../generated/prisma/client';

/**
 * check-cierres-cli.ts
 *
 * Auditoría 100% solo lectura de ResumenCierreDiario vs Jugadas reales por Banca y Rango.
 */

export async function runCheckCierres(options?: {
  fromStr?: string;
  toStr?: string;
  bancaId?: string | null;
}) {
  const fromDateStr = options?.fromStr || new Date().toISOString().slice(0, 10);
  const toDateStr = options?.toStr || fromDateStr;
  const targetBancaId = options?.bancaId || null;

  console.log(`\n======================================================================`);
  console.log(`📈  AUDITORÍA DE CIERRES DIARIOS (RESUMEN CIERRE DIARIO)`);
  console.log(`📅  Rango: ${fromDateStr} a ${toDateStr}`);
  if (targetBancaId) {
    const b = await prisma.banca.findUnique({ where: { id: targetBancaId }, select: { name: true } });
    console.log(`🏛️  Banca Filtrada: ${b?.name || 'ID ' + targetBancaId}`);
  } else {
    console.log(`🏛️  Bancas: TODAS`);
  }
  console.log(`======================================================================\n`);

  // Generar lista de fechas
  const dates: string[] = [];
  let curr = new Date(fromDateStr + 'T00:00:00Z');
  const end = new Date(toDateStr + 'T00:00:00Z');
  while (curr <= end) {
    dates.push(curr.toISOString().slice(0, 10));
    curr.setUTCDate(curr.getUTCDate() + 1);
  }

  let grandTotalGroups = 0;
  let grandTotalDiscrepancies = 0;

  for (const dateStr of dates) {
    const rcdBancaWhere = targetBancaId
      ? Prisma.sql`AND rcd."bancaId" = ${targetBancaId}::uuid`
      : Prisma.empty;

    const tBancaWhere = targetBancaId
      ? Prisma.sql`AND t."bancaId" = ${targetBancaId}::uuid`
      : Prisma.empty;

    // 1. Obtener cierres guardados desde DB via SQL
    const storedRollups = await prisma.$queryRaw<Array<{
      sorteoId: string;
      vendedorId: string;
      sorteoName: string;
      vendedorName: string;
      bancaName: string;
      ventasDB: number;
      premiosDB: number;
      comisionDB: number;
    }>>`
      SELECT 
        rcd."sorteoId",
        rcd."vendedorId",
        COALESCE(s.name, 'Sorteo ' || rcd."sorteoId"::text) AS "sorteoName",
        COALESCE(u.name, 'Vendedor ' || rcd."vendedorId"::text) AS "vendedorName",
        COALESCE(b.name, 'Global') AS "bancaName",
        COALESCE(SUM(rcd."totalVendida"), 0)::float AS "ventasDB",
        COALESCE(SUM(rcd."ganado"), 0)::float AS "premiosDB",
        COALESCE(SUM(rcd."comisionTotal"), 0)::float AS "comisionDB"
      FROM "ResumenCierreDiario" rcd
      LEFT JOIN "Sorteo" s ON s.id = rcd."sorteoId"
      LEFT JOIN "User" u ON u.id = rcd."vendedorId"
      LEFT JOIN "Banca" b ON b.id = rcd."bancaId"
      WHERE rcd."businessDate" = ${dateStr}::date
        ${rcdBancaWhere}
      GROUP BY rcd."sorteoId", rcd."vendedorId", s.name, u.name, b.name
    `;

    if (storedRollups.length === 0) {
      console.log(`📅  FECHA ${dateStr}: ⚠️  No hay registros de ResumenCierreDiario guardados.`);
      continue;
    }

    // 2. Agrupar calculados en vivo desde Ticket
    const liveAggregates = await prisma.$queryRaw<Array<{
      sorteoId: string;
      vendedorId: string;
      ventasReales: number;
      premiosReales: number;
      comisionReales: number;
    }>>`
      WITH relevant_tickets AS (
        SELECT 
          t.id,
          t."vendedorId",
          t."sorteoId",
          t."totalAmount",
          t."totalPayout",
          t."totalListeroCommission"
        FROM "Ticket" t
        JOIN "Sorteo" s ON t."sorteoId" = s.id
        WHERE t."businessDate" = ${dateStr}::date
          AND t.status != 'CANCELLED'
          AND t."isActive" = true
          AND t."deletedAt" IS NULL
          AND s.status = 'EVALUATED'
          ${tBancaWhere}
      )
      SELECT 
        "sorteoId",
        "vendedorId",
        COALESCE(SUM("totalAmount"), 0)::float AS "ventasReales",
        COALESCE(SUM("totalPayout"), 0)::float AS "premiosReales",
        COALESCE(SUM("totalListeroCommission"), 0)::float AS "comisionReales"
      FROM relevant_tickets
      GROUP BY "sorteoId", "vendedorId"
    `;

    const liveMap = new Map<string, { ventasReales: number; premiosReales: number; comisionReales: number }>();
    for (const live of liveAggregates) {
      const key = `${live.sorteoId}_${live.vendedorId}`;
      liveMap.set(key, live);
    }

    let dateDiscrepancies = 0;
    const discrepancies: string[] = [];

    for (const r of storedRollups) {
      grandTotalGroups++;
      const key = `${r.sorteoId}_${r.vendedorId}`;
      const live = liveMap.get(key) || { ventasReales: 0, premiosReales: 0, comisionReales: 0 };

      const diffSales = Math.abs(Number(r.ventasDB) - live.ventasReales);
      const diffPayouts = Math.abs(Number(r.premiosDB) - live.premiosReales);
      const diffComm = Math.abs(Number(r.comisionDB) - live.comisionReales);

      if (diffSales > 0.01 || diffPayouts > 0.01 || diffComm > 0.01) {
        dateDiscrepancies++;
        grandTotalDiscrepancies++;
        discrepancies.push(
          `   ⚠️  [DESCUADRE] Sorteo: ${r.sorteoName} │ Vendedor: ${r.vendedorName} │ Banca: ${r.bancaName}\n` +
          `      Ventas DB: ${formatCRC(Number(r.ventasDB))} vs Real: ${formatCRC(live.ventasReales)}\n` +
          `      Premios DB: ${formatCRC(Number(r.premiosDB))} vs Real: ${formatCRC(live.premiosReales)}\n` +
          `      Comisión DB: ${formatCRC(Number(r.comisionDB))} vs Real: ${formatCRC(live.comisionReales)}`
        );
      }
    }

    if (dateDiscrepancies === 0) {
      console.log(`📅  FECHA ${dateStr}: ✅  ${storedRollups.length} grupos auditados 100% OK`);
    } else {
      console.log(`📅  FECHA ${dateStr}: ⚠️  ${storedRollups.length} grupos auditados │ 🚨 ${dateDiscrepancies} DESCUADRES ENCONTRADOS`);
      discrepancies.forEach(d => console.log(d));
    }
  }

  console.log(`\n======================================================================`);
  if (grandTotalDiscrepancies === 0) {
    console.log(`🎉  RESUMEN DE CIERRES DIARIOS: ${grandTotalGroups} GRUPOS EVALUADOS │ 100% OK │ 0 DESCUADRES`);
  } else {
    console.log(`⚠️  RESUMEN DE CIERRES DIARIOS: ${grandTotalGroups} GRUPOS EVALUADOS │ 🚨 ${grandTotalDiscrepancies} DESCUADRES ENCONTRADOS`);
  }
  console.log(`======================================================================\n`);
}
