import 'dotenv/config';
import { ask, isBack, colors, clearScreen, selectBancaPrompt, promptDateRange } from './helpers';
import { runCheckStatements } from './check-statements-cli';
import { runFixStatements } from './fix-statements-cli';
import { runCheckCierres } from './check-cierres-cli';
import { runAcopioSalesRebuild } from './acopio-cli';

/**
 * accounting-cli.ts
 *
 * MÓDULO CLI PARA CONTABILIDAD, CIERRES Y BALANCES
 *
 * Opciones:
 * 1. Auditoría y Chequeo de Saldos por Banca (AccountStatement)
 * 2. Corrección y Re-Sincronización de Saldos (AccountStatement Fix)
 * 3. Auditoría de Cierres Diarios por Banca (ResumenCierreDiario)
 * 4. Re-Agregación de Acopio de Ventas por Número (DailyNumberSales)
 */

export async function runAccountingWizard() {
  while (true) {
    clearScreen();
    console.log(`======================================================================`);
    console.log(`📊  ${colors.bold}${colors.brightCyan}CONTABILIDAD, CIERRES Y BALANCES${colors.reset}`);
    console.log(`======================================================================`);
    console.log(`Seleccione una opción:`);
    console.log(`  [1] 📋  Auditoría y Chequeo de Saldos por Banca (AccountStatement)`);
    console.log(`  [2] 🔧  Corrección y Re-Sincronización de Saldos (AccountStatement Fix)`);
    console.log(`  [3] 📈  Auditoría de Cierres Diarios por Banca (ResumenCierreDiario)`);
    console.log(`  [4] 🧮  Re-Agregación de Acopio de Ventas (DailyNumberSales)`);
    console.log(`  [B] ⬅️   Volver al Menú Principal`);

    const choice = await ask(`\nOpción (1-4 o B para volver): `);

    if (isBack(choice)) {
      break;
    }

    if (choice === '1') {
      const dates = await promptDateRange();
      if (dates.isBack) continue;
      const banca = await selectBancaPrompt();
      if (banca.isBack) continue;
      await runCheckStatements({ fromStr: dates.fromStr, toStr: dates.toStr, bancaId: banca.id });
      await ask(`\nPresione ENTER para continuar...`);
    } else if (choice === '2') {
      const dates = await promptDateRange();
      if (dates.isBack) continue;
      const banca = await selectBancaPrompt();
      if (banca.isBack) continue;
      const confirm = await ask(
        `⚠️  ¿CONFIRMA RE-SINCRONIZAR SALDOS PARA ${banca.name} (${dates.fromStr} a ${dates.toStr})? (si/no): `
      );
      if (confirm.toLowerCase() === 'si' || confirm.toLowerCase() === 's') {
        await runFixStatements({ fromStr: dates.fromStr, toStr: dates.toStr, bancaId: banca.id });
      } else {
        console.log(`❌  Operación cancelada.`);
      }
      await ask(`\nPresione ENTER para continuar...`);
    } else if (choice === '3') {
      const dates = await promptDateRange();
      if (dates.isBack) continue;
      const banca = await selectBancaPrompt();
      if (banca.isBack) continue;
      await runCheckCierres({ fromStr: dates.fromStr, toStr: dates.toStr, bancaId: banca.id });
      await ask(`\nPresione ENTER para continuar...`);
    } else if (choice === '4') {
      const dates = await promptDateRange();
      if (dates.isBack) continue;
      const banca = await selectBancaPrompt();
      if (banca.isBack) continue;
      await runAcopioSalesRebuild({ fromStr: dates.fromStr, toStr: dates.toStr, bancaId: banca.id });
      await ask(`\nPresione ENTER para continuar...`);
    } else {
      console.log(`❌  Opción no válida.`);
      await ask(`\nPresione ENTER para continuar...`);
    }
  }
}
