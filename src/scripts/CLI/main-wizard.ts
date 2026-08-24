import 'dotenv/config';
import { ask, isBack, rl, clearScreen } from './helpers';
import prisma from '../../core/prismaClient';
import { crDateService } from '../../utils/crDateService';
import { runCheckStatements } from './check-statements-cli';
import { runFixStatements } from './fix-statements-cli';
import { runCheckCierres } from './check-cierres-cli';
import { runSorteosWizard } from './sorteos-cli';
import { runAcopioSalesRebuild } from './acopio-cli';

/**
 * main-wizard.ts
 *
 * ORQUESTADOR PRINCIPAL DE LA SUITE CLI DE SOPORTE TÉCNICO Y OPERACIONES (RENDER / CLI)
 * Punto de entrada único para ejecutar auditorías, reparaciones y operaciones sobre sorteos.
 *
 * USO:
 *   node --max-old-space-size=100 dist/scripts/CLI/main-wizard.js
 *   npm run ops
 */

async function selectBancaPrompt(): Promise<{ id: string | null; name: string; isBack: boolean }> {
  const bancas = await prisma.banca.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' }
  });

  console.log(`\n🏛️  Seleccione la Banca:`);
  console.log(`   [0] Todas las Bancas / Global`);
  bancas.forEach((b, index) => {
    console.log(`   [${index + 1}] ${b.name} [ID: ${b.id}]`);
  });
  console.log(`   [B] ⬅️  Volver al menú principal`);

  const choice = await ask(`   Opción (0-${bancas.length} o B para volver): `);
  if (isBack(choice)) {
    return { id: null, name: '', isBack: true };
  }

  const idx = parseInt(choice, 10);
  if (!isNaN(idx) && idx > 0 && idx <= bancas.length) {
    return { id: bancas[idx - 1].id, name: bancas[idx - 1].name, isBack: false };
  }
  return { id: null, name: 'TODAS LAS BANCAS', isBack: false };
}

async function promptDateRange(): Promise<{ fromStr: string; toStr: string; isBack: boolean }> {
  const todayCR = crDateService.dateUTCToCRString(new Date());
  const fromInput = await ask(`\n📅  Ingrese la Fecha Inicio (YYYY-MM-DD) [ENTER para hoy (${todayCR}), B para volver]: `);
  if (isBack(fromInput)) return { fromStr: '', toStr: '', isBack: true };

  const fromStr = fromInput || todayCR;

  const toInput = await ask(`📅  Ingrese la Fecha Fin (YYYY-MM-DD) [ENTER para misma fecha (${fromStr}), B para volver]: `);
  if (isBack(toInput)) return { fromStr: '', toStr: '', isBack: true };

  const toStr = toInput || fromStr;

  return { fromStr, toStr, isBack: false };
}

async function main() {
  while (true) {
    clearScreen();
    console.log(`======================================================================`);
    console.log(`🛠️   SUITE DE SOPORTE TÉCNICO Y OPERACIONES (RENDER SHELL & CLI)`);
    console.log(`======================================================================`);
    console.log(`Seleccione el módulo de trabajo:`);
    console.log(`  [1] 🎰  Operaciones sobre Sorteos (Listar, Evaluar, Revertir, Cerrar, Reabrir)`);
    console.log(`  [2] 📊  Auditoría y Chequeo de Saldos por Banca (AccountStatement)`);
    console.log(`  [3] 🔧  Corrección y Re-Sincronización de Saldos (AccountStatement Fix)`);
    console.log(`  [4] 📈  Auditoría de Cierres Diarios por Banca (ResumenCierreDiario)`);
    console.log(`  [5] 🧮  Re-Agregación de Acopio de Ventas (DailyNumberSales)`);
    console.log(`  [0] 🚪  Salir`);

    const optionChoice = await ask(`\nOpción (0-5): `);

    if (optionChoice === '0' || isBack(optionChoice)) {
      console.log(`\n👋  Saliendo de la Suite de Soporte.`);
      break;
    }

    if (optionChoice === '1') {
      await runSorteosWizard();
    } else if (optionChoice === '2') {
      const dates = await promptDateRange();
      if (dates.isBack) continue;
      const banca = await selectBancaPrompt();
      if (banca.isBack) continue;
      await runCheckStatements({ fromStr: dates.fromStr, toStr: dates.toStr, bancaId: banca.id });
      await ask(`\nPresione ENTER para continuar...`);
    } else if (optionChoice === '3') {
      const dates = await promptDateRange();
      if (dates.isBack) continue;
      const banca = await selectBancaPrompt();
      if (banca.isBack) continue;
      const confirm = await ask(`⚠️  ¿CONFIRMA RE-SINCRONIZAR SALDOS PARA ${banca.name} (${dates.fromStr} a ${dates.toStr})? (si/no): `);
      if (confirm.toLowerCase() === 'si' || confirm.toLowerCase() === 's') {
        await runFixStatements({ fromStr: dates.fromStr, toStr: dates.toStr, bancaId: banca.id });
      } else {
        console.log(`❌  Operación cancelada.`);
      }
      await ask(`\nPresione ENTER para continuar...`);
    } else if (optionChoice === '4') {
      const dates = await promptDateRange();
      if (dates.isBack) continue;
      const banca = await selectBancaPrompt();
      if (banca.isBack) continue;
      await runCheckCierres({ fromStr: dates.fromStr, toStr: dates.toStr, bancaId: banca.id });
      await ask(`\nPresione ENTER para continuar...`);
    } else if (optionChoice === '5') {
      const dates = await promptDateRange();
      if (dates.isBack) continue;
      const banca = await selectBancaPrompt();
      if (banca.isBack) continue;
      await runAcopioSalesRebuild({ fromStr: dates.fromStr, toStr: dates.toStr, bancaId: banca.id });
      await ask(`\nPresione ENTER para continuar...`);
    } else {
      console.log(`❌  Opción no válida.`);
    }
  }

  rl.close();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(`\n❌  ERROR FATAL: ${err.message}`);
  rl.close();
  prisma.$disconnect().then(() => process.exit(1));
});
