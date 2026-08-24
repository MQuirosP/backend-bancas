import 'dotenv/config';
import prisma from '../../src/core/prismaClient';
import { renderProgressBar, colors, ask, formatCRC } from './helpers';
import { DailyNumberSalesService } from '../../src/api/v1/services/dailyNumberSales.service';
import ActivityService from '../../src/core/activity.service';
import { ActivityType } from '../../src/generated/prisma/client';

/**
 * acopio-cli.ts
 *
 * Auditoría y Re-agregación masiva de acopio de ventas por número (DailyNumberSales).
 * Audita primero si existen discrepancias entre el acopio guardado y las jugadas reales del sorteo.
 */

export async function runAcopioSalesRebuild(options?: {
  fromStr?: string;
  toStr?: string;
  bancaId?: string | null;
}) {
  const fromDateStr = options?.fromStr || new Date().toISOString().slice(0, 10);
  const toDateStr = options?.toStr || fromDateStr;
  const targetBancaId = options?.bancaId || null;

  console.log(`\n======================================================================`);
  console.log(`🧮  AUDITORÍA Y RE-AGREGACIÓN DE ACOPIO DE VENTAS (DAILY NUMBER SALES)`);
  console.log(`📅  Rango: ${fromDateStr} a ${toDateStr}`);
  if (targetBancaId) {
    const b = await prisma.banca.findUnique({ where: { id: targetBancaId }, select: { name: true } });
    console.log(`🏛️  Banca Filtrada: ${b?.name || 'ID ' + targetBancaId}`);
  } else {
    console.log(`🏛️  Bancas: TODAS`);
  }
  console.log(`======================================================================\n`);

  // Calcular fechas UTC
  const [fromY, fromM, fromD] = fromDateStr.split('-').map(Number);
  const [toY, toM, toD] = toDateStr.split('-').map(Number);
  const startOfDayUTC = new Date(Date.UTC(fromY, fromM - 1, fromD, 6, 0, 0, 0));
  const endOfDayUTC = new Date(Date.UTC(toY, toM - 1, toD + 1, 5, 59, 59, 999));

  // Buscar sorteos evaluados en el rango
  const sorteos = await prisma.sorteo.findMany({
    where: {
      scheduledAt: { gte: startOfDayUTC, lte: endOfDayUTC },
      status: 'EVALUATED',
      isActive: true,
      ...(targetBancaId ? { bancaId: targetBancaId } : {})
    },
    include: {
      banca: { select: { name: true } }
    },
    orderBy: { scheduledAt: 'asc' }
  });

  if (sorteos.length === 0) {
    console.log(`⚠️  No se encontraron sorteos EVALUADOS en el rango ${fromDateStr} a ${toDateStr}.`);
    return;
  }

  console.log(`⏳  Auditando discrepancias en acopio para ${sorteos.length} sorteo(s) evaluados...\n`);

  let totalDiscrepancies = 0;
  const sorteosWithDiscrepancies: typeof sorteos = [];

  for (let i = 0; i < sorteos.length; i++) {
    const s = sorteos[i];
    renderProgressBar(i + 1, sorteos.length, `Auditando: ${s.name}`);

    // 1. Obtener totales guardados en DailyNumberSales
    const storedRes = await prisma.$queryRaw<Array<{ totalDB: number; jugadasDB: number }>>`
      SELECT 
        COALESCE(SUM("totalAmount"), 0)::float AS "totalDB",
        COALESCE(SUM("jugadasCount"), 0)::integer AS "jugadasDB"
      FROM "DailyNumberSales"
      WHERE "sorteoId" = ${s.id}::uuid
    `;

    // 2. Obtener totales calculados en vivo desde Jugada + Ticket
    const liveRes = await prisma.$queryRaw<Array<{ totalReal: number; jugadasReal: number }>>`
      SELECT 
        COALESCE(SUM(j.amount), 0)::float AS "totalReal",
        COUNT(j.id)::integer AS "jugadasReal"
      FROM "Jugada" j
      JOIN "Ticket" t ON j."ticketId" = t.id
      WHERE t."sorteoId" = ${s.id}::uuid
        AND t."deletedAt" IS NULL
        AND t."isActive" = true
        AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
        AND j."deletedAt" IS NULL
    `;

    const stored = storedRes[0] || { totalDB: 0, jugadasDB: 0 };
    const live = liveRes[0] || { totalReal: 0, jugadasReal: 0 };

    const diffAmount = Math.abs(stored.totalDB - live.totalReal);
    const diffJugadas = Math.abs(stored.jugadasDB - live.jugadasReal);

    const timeFormatted = new Date(s.scheduledAt).toLocaleTimeString('es-CR', {
      timeZone: 'America/Costa_Rica',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });

    if (diffAmount > 0.01 || diffJugadas > 0) {
      totalDiscrepancies++;
      sorteosWithDiscrepancies.push(s);
      console.log(
        `\r⚠️  [DESCUADRE ACOPIO] Sorteo: ${colors.bold}${s.name}${colors.reset} (${s.banca?.name || 'Global'}) │ Hora: ${timeFormatted}\n` +
        `    DB Acopio: ${formatCRC(stored.totalDB)} (${stored.jugadasDB} jugadas) vs Real: ${formatCRC(live.totalReal)} (${live.jugadasReal} jugadas)`
      );
    }
  }

  console.log(`\n----------------------------------------------------------------------`);
  if (totalDiscrepancies === 0) {
    console.log(`✅  AUDITORÍA DE ACOPIO: ${sorteos.length} Sorteos evaluados 100% OK │ 0 Descuadres`);
  } else {
    console.log(`⚠️  AUDITORÍA DE ACOPIO: ${sorteos.length} Sorteos evaluados │ 🚨 ${totalDiscrepancies} DESCUADRES DETECTADOS`);
  }
  console.log(`----------------------------------------------------------------------\n`);

  // Preguntar confirmación
  const questionPrompt = totalDiscrepancies > 0
    ? `⚠️  ¿DESEA RE-CALCULAR Y CORREGIR EL ACOPIO PARA LOS ${totalDiscrepancies} SORTEOS CON DESCUADRES? (si/no): `
    : `💡  El acopio está 100% OK. ¿Desea forzar la re-agregación de todas formas? (si/no): `;

  const confirm = await ask(questionPrompt);
  if (confirm.toLowerCase() !== 'si' && confirm.toLowerCase() !== 's') {
    console.log(`\n❌  Operación cancelada por el usuario. No se realizaron cambios.`);
    return;
  }

  const targetSorteosToProcess = totalDiscrepancies > 0 ? sorteosWithDiscrepancies : sorteos;

  console.log(`\n⏳  Ejecutando acopio de ventas...\n`);

  for (let i = 0; i < targetSorteosToProcess.length; i++) {
    const s = targetSorteosToProcess[i];
    renderProgressBar(i + 1, targetSorteosToProcess.length, `Procesando: ${s.name}`);
    await DailyNumberSalesService.aggregateSorteoSales(s.id);
  }

  // Registrar en ActivityLog
  await ActivityService.log({
    action: ActivityType.SYSTEM_ACTION,
    targetType: 'DAILY_NUMBER_SALES',
    bancaId: targetBancaId || null,
    details: {
      source: 'CLI_MAIN_WIZARD',
      module: 'REBUILD_ACOPIO_SALES',
      range: { from: fromDateStr, to: toDateStr },
      sorteosProcessed: targetSorteosToProcess.length,
      discrepanciesFound: totalDiscrepancies,
      executedBy: 'SUPER_ADMIN'
    }
  });

  console.log(`\n======================================================================`);
  console.log(`🎉  ACOPIO DE VENTAS RECALCULADO EXITOSAMENTE (${targetSorteosToProcess.length} SORTEOS)`);
  console.log(`📌  Registrado en ActivityLog | Rango: ${fromDateStr} a ${toDateStr}`);
  console.log(`======================================================================\n`);
}
