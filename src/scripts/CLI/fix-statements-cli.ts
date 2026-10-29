import 'dotenv/config';
import { renderProgressBar, IS_RENDER, callOpsApi } from './helpers';

/**
 * fix-statements-cli.ts
 *
 * Herramienta de reparación y sincronización de saldos en AccountStatement por Banca y Rango.
 * En Render: ejecuta acciones vía llamadas HTTP ultralivianas.
 * En Local: ejecuta directo en Prisma.
 */

export async function runFixStatements(options?: {
  fromStr?: string;
  toStr?: string;
  bancaId?: string | null;
}) {
  const fromDateStr = options?.fromStr || new Date().toISOString().slice(0, 10);
  const toDateStr = options?.toStr || fromDateStr;
  const targetBancaId = options?.bancaId || null;

  console.log(`\n======================================================================`);
  console.log(`🔧  REPARACIÓN Y RE-SINCRONIZACIÓN DE SALDOS (ACCOUNT STATEMENT & MONTHLY CLOSING)`);
  console.log(`📅  Rango: ${fromDateStr} a ${toDateStr}`);
  console.log(`🏛️  Banca: ${targetBancaId ? 'ID ' + targetBancaId : 'TODAS'}`);
  console.log(`======================================================================\n`);

  if (IS_RENDER) {
    console.log(`⏳  Ejecutando reparación de saldos vía API en servidor interno (Render Mode)...`);
    const res = await callOpsApi('/statements/fix', { fromStr: fromDateStr, toStr: toDateStr, bancaId: targetBancaId });
    console.log(`\n======================================================================`);
    console.log(`🎉  REPARACIÓN Y CIERRE MENSUAL COMPLETADO EXITOSAMENTE`);
    console.log(`📌  Registros Procesados: ${res.totalProcessed} en el rango ${fromDateStr} a ${toDateStr}`);
    console.log(`======================================================================\n`);
    return;
  }

  const { default: prisma } = await import('../../core/prismaClient');
  const { AccountStatementSyncService } = await import('../../domain/accounts/accounts.sync.service');
  const { recalculateMonthlyClosingForDimension } = await import('../../domain/accounts/monthlyClosing.service');
  const { default: ActivityService } = await import('../../core/activity.service');
  const { ActivityType } = await import('../../generated/prisma/client');

  // MODO LOCAL: Conexión Prisma directa sin cambios
  const dates: string[] = [];
  const monthsSet = new Set<string>();

  let curr = new Date(fromDateStr + 'T00:00:00Z');
  const end = new Date(toDateStr + 'T00:00:00Z');
  while (curr <= end) {
    const dStr = curr.toISOString().slice(0, 10);
    dates.push(dStr);
    monthsSet.add(dStr.slice(0, 7));
    curr.setUTCDate(curr.getUTCDate() + 1);
  }

  const vendedores = await prisma.user.findMany({
    where: {
      role: 'VENDEDOR',
      isActive: true,
      ...(targetBancaId ? { bancaId: targetBancaId } : {})
    },
    select: { id: true, name: true, bancaId: true, ventanaId: true }
  });

  const ventanas = await prisma.ventana.findMany({
    where: {
      isActive: true,
      ...(targetBancaId ? { bancaId: targetBancaId } : {})
    },
    select: { id: true, name: true, bancaId: true }
  });

  const bancas = await prisma.banca.findMany({
    where: {
      isActive: true,
      ...(targetBancaId ? { id: targetBancaId } : {})
    },
    select: { id: true, name: true }
  });

  let totalProcessed = 0;

  for (const dateStr of dates) {
    const dateObj = new Date(dateStr + 'T00:00:00Z');
    console.log(`📅  Sincronizando fecha ${dateStr}...`);

    const totalEntitiesInDate = vendedores.length + ventanas.length + bancas.length;
    let dateCount = 0;

    for (let i = 0; i < vendedores.length; i++) {
      const v = vendedores[i];
      dateCount++;
      totalProcessed++;
      renderProgressBar(dateCount, totalEntitiesInDate, `Vendedor: ${v.name}`);
      await (AccountStatementSyncService as any)._syncDayStatementInternal(dateObj, 'vendedor', v.id);
    }

    for (let i = 0; i < ventanas.length; i++) {
      const vt = ventanas[i];
      dateCount++;
      totalProcessed++;
      renderProgressBar(dateCount, totalEntitiesInDate, `Ventana: ${vt.name}`);
      await (AccountStatementSyncService as any)._syncDayStatementInternal(dateObj, 'ventana', vt.id);
    }

    for (let i = 0; i < bancas.length; i++) {
      const b = bancas[i];
      dateCount++;
      totalProcessed++;
      renderProgressBar(dateCount, totalEntitiesInDate, `Banca: ${b.name}`);
      await (AccountStatementSyncService as any)._syncDayStatementInternal(dateObj, 'banca', b.id);
    }

    console.log(`   ✅  Fecha ${dateStr} sincronizada (${totalEntitiesInDate} entidades).`);
  }

  console.log(`\n⏳  Actualizando Cierres Mensuales (MonthlyClosingBalance) para ${monthsSet.size} mes(es)...`);
  for (const monthStr of monthsSet) {
    for (const v of vendedores) {
      await recalculateMonthlyClosingForDimension(monthStr, 'vendedor', v.ventanaId || undefined, v.id, v.bancaId || undefined);
    }
    for (const vt of ventanas) {
      await recalculateMonthlyClosingForDimension(monthStr, 'ventana', vt.id, undefined, vt.bancaId || undefined);
    }
    for (const b of bancas) {
      await recalculateMonthlyClosingForDimension(monthStr, 'banca', undefined, undefined, b.id);
    }
  }

  await ActivityService.log({
    action: ActivityType.SYSTEM_ACTION,
    targetType: 'ACCOUNT_STATEMENT',
    bancaId: targetBancaId || null,
    details: {
      source: 'CLI_MAIN_WIZARD',
      module: 'FIX_STATEMENTS',
      range: { from: fromDateStr, to: toDateStr },
      recordsProcessed: totalProcessed,
      executedBy: 'SUPER_ADMIN'
    }
  });

  console.log(`\n======================================================================`);
  console.log(`🎉  REPARACIÓN Y CIERRE MENSUAL COMPLETADO EXITOSAMENTE (REGISTRADO EN LOGS)`);
  console.log(`📌  Registros Procesados: ${totalProcessed} en el rango ${fromDateStr} a ${toDateStr}`);
  console.log(`======================================================================\n`);
}
