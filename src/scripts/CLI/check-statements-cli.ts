import 'dotenv/config';
import { formatCRC, renderProgressBar } from './helpers';
import prisma from '../../core/prismaClient';
import { AccountsService } from '../../domain/accounts/accounts.service';

/**
 * check-statements-cli.ts
 *
 * Chequeo limpio de integridad de saldos en AccountStatement por Banca y Rango de Fechas.
 * Muestra barra de progreso interactiva en tiempo real y resumen OK/FAIL.
 */

export async function runCheckStatements(options?: {
  fromStr?: string;
  toStr?: string;
  bancaId?: string | null;
}) {
  const fromDateStr = options?.fromStr || new Date().toISOString().slice(0, 10);
  const toDateStr = options?.toStr || fromDateStr;
  const targetBancaId = options?.bancaId || null;

  console.log(`\n======================================================================`);
  console.log(`📊  AUDITORÍA Y CHEQUEO DE INTEGRIDAD DE SALDOS (ACCOUNT STATEMENT)`);
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

  // Cargar entidades según filtro de banca
  const vendedores = await prisma.user.findMany({
    where: {
      role: 'VENDEDOR',
      isActive: true,
      ...(targetBancaId ? { bancaId: targetBancaId } : {})
    },
    select: { id: true, name: true, bancaId: true }
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

  let totalChecked = 0;
  let totalOk = 0;
  let totalFail = 0;

  for (const dateStr of dates) {
    console.log(`📅  FECHA: ${dateStr}`);
    const dateObj = new Date(dateStr + 'T00:00:00Z');

    // ── VENDEDORES ──
    let vendOk = 0;
    let vendFail = 0;
    const vendFailDetails: string[] = [];

    for (let i = 0; i < vendedores.length; i++) {
      const v = vendedores[i];
      renderProgressBar(i + 1, vendedores.length, `Vendedor: ${v.name}`);

      totalChecked++;
      const dbStmt = await prisma.accountStatement.findFirst({
        where: { vendedorId: v.id, date: dateObj, ventanaId: null }
      });

      const dbBalance = dbStmt ? Number(dbStmt.balance) : 0;
      const dbAccumulated = dbStmt ? Number(dbStmt.accumulatedBalance) : 0;
      const dbRemaining = dbStmt ? Number(dbStmt.remainingBalance) : 0;

      let realBalance = 0;
      let realAccumulated: number | null = null;
      try {
        const bySorteoData = await AccountsService.getBySorteo(dateStr, {
          dimension: 'vendedor',
          vendedorId: v.id
        });

        if (bySorteoData && Array.isArray(bySorteoData) && bySorteoData.length > 0) {
          let sSales = 0, sPayouts = 0, sComm = 0;
          for (const ev of bySorteoData) {
            const isMov = (ev.sorteoId || '').startsWith('mov-');
            if (!isMov) {
              sSales += Number(ev.sales || 0);
              sPayouts += Number(ev.payouts || 0);
              sComm += Number(ev.vendedorCommission || 0);
            }
          }
          realBalance = parseFloat((sSales - sPayouts - sComm).toFixed(2));
          const lastEvent = bySorteoData.reduce(
            (max: any, e: any) => (e.chronologicalIndex || 0) > (max.chronologicalIndex || 0) ? e : max,
            bySorteoData[0]
          );
          realAccumulated = parseFloat(Number(lastEvent.accumulated || 0).toFixed(2));
        }
      } catch (err) {
        realBalance = dbBalance;
        realAccumulated = dbAccumulated;
      }

      const diffBalance = Math.abs(dbBalance - realBalance);
      const diffAccumulated = realAccumulated !== null ? Math.abs(dbAccumulated - realAccumulated) : 0;
      const diffInternal = dbStmt ? Math.abs(dbAccumulated - dbRemaining) : 0;

      const isBalanceOk = diffBalance < 0.01;
      const isAccumulatedOk = diffAccumulated < 0.01;
      const isInternalOk = diffInternal < 0.01;

      if (isBalanceOk && isAccumulatedOk && isInternalOk) {
        vendOk++;
        totalOk++;
      } else {
        vendFail++;
        totalFail++;
        if (!isBalanceOk) {
          vendFailDetails.push(
            `   ⚠️  [FAIL BAL]  ${v.name.padEnd(25, ' ')} │ DB Bal: ${formatCRC(dbBalance).padEnd(14, ' ')} != Calc Bal: ${formatCRC(realBalance).padEnd(14, ' ')} (Diff: ${formatCRC(diffBalance)})`
          );
        }
        if (!isAccumulatedOk) {
          vendFailDetails.push(
            `   ⚠️  [FAIL ACUM] ${v.name.padEnd(25, ' ')} │ DB Acum: ${formatCRC(dbAccumulated).padEnd(14, ' ')} != Calc Acum: ${formatCRC(realAccumulated!).padEnd(14, ' ')} (Diff: ${formatCRC(diffAccumulated)})`
          );
        }
        if (!isInternalOk) {
          vendFailDetails.push(
            `   ⚠️  [FAIL ASYNC] ${v.name.padEnd(25, ' ')} │ DB Acum: ${formatCRC(dbAccumulated).padEnd(14, ' ')} != DB Rem: ${formatCRC(dbRemaining).padEnd(14, ' ')} (Diff: ${formatCRC(diffInternal)})`
          );
        }
      }
    }

    console.log(`👥  VENDEDORES (${vendedores.length}): ${vendOk} OK ${vendFail > 0 ? `│ ⚠️  ${vendFail} DESCUADRES` : ''}`);
    if (vendFailDetails.length > 0) {
      vendFailDetails.forEach(d => console.log(d));
    }

    // ── VENTANAS ──
    let ventOk = 0;
    let ventFail = 0;
    const ventFailDetails: string[] = [];

    for (let i = 0; i < ventanas.length; i++) {
      const vt = ventanas[i];
      renderProgressBar(i + 1, ventanas.length, `Ventana: ${vt.name}`);

      totalChecked++;
      const dbStmt = await prisma.accountStatement.findFirst({
        where: { ventanaId: vt.id, date: dateObj, vendedorId: null }
      });

      const dbBalance = dbStmt ? Number(dbStmt.balance) : 0;
      const dbAccumulated = dbStmt ? Number(dbStmt.accumulatedBalance) : 0;
      const dbRemaining = dbStmt ? Number(dbStmt.remainingBalance) : 0;

      let realBalance = 0;
      let realAccumulated: number | null = null;
      try {
        const bySorteoData = await AccountsService.getBySorteo(dateStr, {
          dimension: 'ventana',
          ventanaId: vt.id
        });

        if (bySorteoData && Array.isArray(bySorteoData) && bySorteoData.length > 0) {
          let sSales = 0, sPayouts = 0, sComm = 0;
          for (const ev of bySorteoData) {
            const isMov = (ev.sorteoId || '').startsWith('mov-');
            if (!isMov) {
              sSales += Number(ev.sales || 0);
              sPayouts += Number(ev.payouts || 0);
              sComm += Number(ev.listeroCommission || 0);
            }
          }
          realBalance = parseFloat((sSales - sPayouts - sComm).toFixed(2));
          const lastEvent = bySorteoData.reduce(
            (max: any, e: any) => (e.chronologicalIndex || 0) > (max.chronologicalIndex || 0) ? e : max,
            bySorteoData[0]
          );
          realAccumulated = parseFloat(Number(lastEvent.accumulated || 0).toFixed(2));
        }
      } catch (err) {
        realBalance = dbBalance;
        realAccumulated = dbAccumulated;
      }

      const diffBalance = Math.abs(dbBalance - realBalance);
      const diffAccumulated = realAccumulated !== null ? Math.abs(dbAccumulated - realAccumulated) : 0;
      const diffInternal = dbStmt ? Math.abs(dbAccumulated - dbRemaining) : 0;

      const isBalanceOk = diffBalance < 0.01;
      const isAccumulatedOk = diffAccumulated < 0.01;
      const isInternalOk = diffInternal < 0.01;

      if (isBalanceOk && isAccumulatedOk && isInternalOk) {
        ventOk++;
        totalOk++;
      } else {
        ventFail++;
        totalFail++;
        if (!isBalanceOk) {
          ventFailDetails.push(
            `   ⚠️  [FAIL BAL]  ${vt.name.padEnd(25, ' ')} │ DB Bal: ${formatCRC(dbBalance).padEnd(14, ' ')} != Calc Bal: ${formatCRC(realBalance).padEnd(14, ' ')} (Diff: ${formatCRC(diffBalance)})`
          );
        }
        if (!isAccumulatedOk) {
          ventFailDetails.push(
            `   ⚠️  [FAIL ACUM] ${vt.name.padEnd(25, ' ')} │ DB Acum: ${formatCRC(dbAccumulated).padEnd(14, ' ')} != Calc Acum: ${formatCRC(realAccumulated!).padEnd(14, ' ')} (Diff: ${formatCRC(diffAccumulated)})`
          );
        }
        if (!isInternalOk) {
          ventFailDetails.push(
            `   ⚠️  [FAIL ASYNC] ${vt.name.padEnd(25, ' ')} │ DB Acum: ${formatCRC(dbAccumulated).padEnd(14, ' ')} != DB Rem: ${formatCRC(dbRemaining).padEnd(14, ' ')} (Diff: ${formatCRC(diffInternal)})`
          );
        }
      }
    }

    console.log(`🪟  VENTANAS   (${ventanas.length}): ${ventOk} OK ${ventFail > 0 ? `│ ⚠️  ${ventFail} DESCUADRES` : ''}`);
    if (ventFailDetails.length > 0) {
      ventFailDetails.forEach(d => console.log(d));
    }

    // ── BANCAS ──
    let bancaOk = 0;
    let bancaFail = 0;
    const bancaFailDetails: string[] = [];

    for (let i = 0; i < bancas.length; i++) {
      const b = bancas[i];
      renderProgressBar(i + 1, bancas.length, `Banca: ${b.name}`);

      totalChecked++;
      const dbStmt = await prisma.accountStatement.findFirst({
        where: { bancaId: b.id, date: dateObj, ventanaId: null, vendedorId: null }
      });

      const dbBalance = dbStmt ? Number(dbStmt.balance) : 0;
      const dbAccumulated = dbStmt ? Number(dbStmt.accumulatedBalance) : 0;
      const dbRemaining = dbStmt ? Number(dbStmt.remainingBalance) : 0;

      let realBalance = 0;
      let realAccumulated: number | null = null;
      try {
        const bySorteoData = await AccountsService.getBySorteo(dateStr, {
          dimension: 'banca',
          bancaId: b.id
        });

        if (bySorteoData && Array.isArray(bySorteoData) && bySorteoData.length > 0) {
          let sSales = 0, sPayouts = 0, sComm = 0;
          for (const ev of bySorteoData) {
            const isMov = (ev.sorteoId || '').startsWith('mov-');
            if (!isMov) {
              sSales += Number(ev.sales || 0);
              sPayouts += Number(ev.payouts || 0);
              sComm += Number(ev.listeroCommission || 0);
            }
          }
          realBalance = parseFloat((sSales - sPayouts - sComm).toFixed(2));
          const lastEvent = bySorteoData.reduce(
            (max: any, e: any) => (e.chronologicalIndex || 0) > (max.chronologicalIndex || 0) ? e : max,
            bySorteoData[0]
          );
          realAccumulated = parseFloat(Number(lastEvent.accumulated || 0).toFixed(2));
        }
      } catch (err) {
        realBalance = dbBalance;
        realAccumulated = dbAccumulated;
      }

      const diffBalance = Math.abs(dbBalance - realBalance);
      const diffAccumulated = realAccumulated !== null ? Math.abs(dbAccumulated - realAccumulated) : 0;
      const diffInternal = dbStmt ? Math.abs(dbAccumulated - dbRemaining) : 0;

      const isBalanceOk = diffBalance < 0.01;
      const isAccumulatedOk = diffAccumulated < 0.01;
      const isInternalOk = diffInternal < 0.01;

      if (isBalanceOk && isAccumulatedOk && isInternalOk) {
        bancaOk++;
        totalOk++;
      } else {
        bancaFail++;
        totalFail++;
        if (!isBalanceOk) {
          bancaFailDetails.push(
            `   ⚠️  [FAIL BAL]  ${b.name.padEnd(25, ' ')} │ DB Bal: ${formatCRC(dbBalance).padEnd(14, ' ')} != Calc Bal: ${formatCRC(realBalance).padEnd(14, ' ')} (Diff: ${formatCRC(diffBalance)})`
          );
        }
        if (!isAccumulatedOk) {
          bancaFailDetails.push(
            `   ⚠️  [FAIL ACUM] ${b.name.padEnd(25, ' ')} │ DB Acum: ${formatCRC(dbAccumulated).padEnd(14, ' ')} != Calc Acum: ${formatCRC(realAccumulated!).padEnd(14, ' ')} (Diff: ${formatCRC(diffAccumulated)})`
          );
        }
        if (!isInternalOk) {
          bancaFailDetails.push(
            `   ⚠️  [FAIL ASYNC] ${b.name.padEnd(25, ' ')} │ DB Acum: ${formatCRC(dbAccumulated).padEnd(14, ' ')} != DB Rem: ${formatCRC(dbRemaining).padEnd(14, ' ')} (Diff: ${formatCRC(diffInternal)})`
          );
        }
      }
    }

    console.log(`🏛️  BANCAS     (${bancas.length}): ${bancaOk} OK ${bancaFail > 0 ? `│ ⚠️  ${bancaFail} DESCUADRES` : ''}\n`);
    if (bancaFailDetails.length > 0) {
      bancaFailDetails.forEach(d => console.log(d));
    }
  }

  console.log(`======================================================================`);
  if (totalFail === 0) {
    console.log(`🎉  RESUMEN DE AUDITORÍA: ${totalChecked} REGISTROS EVALUADOS │ 100% OK │ 0 DESCUADRES`);
  } else {
    console.log(`⚠️  RESUMEN DE AUDITORÍA: ${totalChecked} REGISTROS EVALUADOS │ ${totalOk} OK │ 🚨 ${totalFail} DESCUADRES ENCONTRADOS`);
  }
  console.log(`======================================================================\n`);
}
