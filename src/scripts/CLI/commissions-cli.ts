import 'dotenv/config';
import { ask, isBack, colors, clearScreen, IS_RENDER, callOpsApi, promptDateRange } from './helpers';
import { crDateService } from '../../utils/crDateService';

/**
 * commissions-cli.ts
 *
 * MÓDULO CLI PARA GESTIÓN DE POLÍTICAS DE COMISIÓN Y RECÁLCULO DE JUGADAS
 *
 * Opciones:
 * 1. Clonar políticas de comisión entre ventanas/bancas.
 * 2. Reaplicar snapshots de comisión en tickets históricos con la política vigente.
 * 3. Normalizar multiplicadores (finalMultiplierX) de jugadas históricas.
 */

export async function runCommissionsWizard() {
  while (true) {
    clearScreen();
    console.log(`======================================================================`);
    console.log(`💰  ${colors.bold}${colors.brightCyan}GESTIÓN DE POLÍTICAS Y COMISIONES${colors.reset}`);
    console.log(`======================================================================`);
    console.log(`Seleccione una opción:`);
    console.log(`  [1] 📋  Clonar Políticas de Comisión entre Ventanas / Bancas`);
    console.log(`  [2] 🔄  Reaplicar Snapshots de Comisiones Históricas`);
    console.log(`  [3] 🔢  Normalizar Multiplicadores Históricos (finalMultiplierX)`);
    console.log(`  [B] ⬅️   Volver al Menú Principal`);

    const choice = await ask(`\nOpción (1-3 o B para volver): `);

    if (isBack(choice)) {
      break;
    }

    if (choice === '1') {
      await handleClonePolicies();
      await ask(`\nPresione ENTER para continuar...`);
    } else if (choice === '2') {
      await handleReapplyCommissions();
      await ask(`\nPresione ENTER para continuar...`);
    } else if (choice === '3') {
      await handleNormalizeMultipliers();
      await ask(`\nPresione ENTER para continuar...`);
    } else {
      console.log(`❌  Opción no válida.`);
      await ask(`\nPresione ENTER para continuar...`);
    }
  }
}

async function handleClonePolicies() {
  console.log(`\n📋  ${colors.bold}CLONACIÓN DE POLÍTICAS DE COMISIÓN${colors.reset}`);
  console.log(`----------------------------------------------------------------------`);

  const sourceVentanaId = await ask(`Ingrese el UUID de la Ventana ORIGEN (o B para volver): `);
  if (isBack(sourceVentanaId) || !sourceVentanaId.trim()) return;

  const targetVentanaId = await ask(`Ingrese el UUID de la Ventana DESTINO (o B para volver): `);
  if (isBack(targetVentanaId) || !targetVentanaId.trim()) return;

  const includeBancaInput = await ask(`¿Clonar también la política de la Banca asociada? (s/N): `);
  const includeBanca = includeBancaInput.toLowerCase() === 's' || includeBancaInput.toLowerCase() === 'si';

  const dryRunInput = await ask(`¿Ejecutar en modo SIMULACIÓN (dryRun)? (S/n): `);
  const dryRun = dryRunInput.toLowerCase() !== 'n' && dryRunInput.toLowerCase() !== 'no';

  console.log(`\n⏳  Procesando clonación (dryRun=${dryRun})...`);

  try {
    const { clonePolicies } = await import('../../tools/maintenance/tasks/clonePolicies');
    await clonePolicies({
      sourceVentanaId: sourceVentanaId.trim(),
      targetVentanaId: targetVentanaId.trim(),
      includeBanca,
      dryRun,
    });
    console.log(`\n✅  ${colors.brightGreen}Operación de clonación finalizada con éxito.${colors.reset}`);
  } catch (err: any) {
    console.log(`\n❌  Error: ${err.message}`);
  }
}

async function handleReapplyCommissions() {
  console.log(`\n🔄  ${colors.bold}REAPLICACIÓN DE SNAPSHOTS DE COMISIÓN${colors.reset}`);
  console.log(`----------------------------------------------------------------------`);
  console.log(`Recalcula comisiones históricas según las políticas actualmente configuradas.`);

  const { fromStr: from, toStr: to, isBack: back } = await promptDateRange();
  if (back) return;

  const ventanaIdInput = await ask(`UUID de Ventana específica [ENTER para todas]: `);
  const ventanaId = ventanaIdInput.trim() || undefined;

  const dryRunInput = await ask(`¿Ejecutar en modo SIMULACIÓN (dryRun)? (S/n): `);
  const dryRun = dryRunInput.toLowerCase() !== 'n' && dryRunInput.toLowerCase() !== 'no';

  const [fromY, fromM, fromD] = from.split('-').map(Number);
  const [toY, toM, toD] = to.split('-').map(Number);
  const fromDate = new Date(Date.UTC(fromY, fromM - 1, fromD, 6, 0, 0, 0));
  const toDate = new Date(Date.UTC(toY, toM - 1, toD + 1, 5, 59, 59, 999));

  console.log(`\n⏳  Procesando tickets del ${from} al ${to} (dryRun=${dryRun})...`);

  try {
    const { reapplyCommissions } = await import('../../tools/maintenance/tasks/reapplyCommissions');
    await reapplyCommissions({
      from: fromDate,
      to: toDate,
      ventanaId,
      dryRun,
    });
    console.log(`\n✅  ${colors.brightGreen}Reaplicación de comisiones finalizada.${colors.reset}`);
  } catch (err: any) {
    console.log(`\n❌  Error: ${err.message}`);
  }
}

async function handleNormalizeMultipliers() {
  console.log(`\n🔢  ${colors.bold}NORMALIZACIÓN DE MULTIPLICADORES (finalMultiplierX)${colors.reset}`);
  console.log(`----------------------------------------------------------------------`);
  console.log(`Ajusta finalMultiplierX en jugadas pasadas sin recalcular comisiones.`);

  const { fromStr: from, toStr: to, isBack: back } = await promptDateRange();
  if (back) return;

  const ventanaIdInput = await ask(`UUID de Ventana específica [ENTER para todas]: `);
  const ventanaId = ventanaIdInput.trim() || undefined;

  const dryRunInput = await ask(`¿Ejecutar en modo SIMULACIÓN (dryRun)? (S/n): `);
  const dryRun = dryRunInput.toLowerCase() !== 'n' && dryRunInput.toLowerCase() !== 'no';

  const [fromY, fromM, fromD] = from.split('-').map(Number);
  const [toY, toM, toD] = to.split('-').map(Number);
  const fromDate = new Date(Date.UTC(fromY, fromM - 1, fromD, 6, 0, 0, 0));
  const toDate = new Date(Date.UTC(toY, toM - 1, toD + 1, 5, 59, 59, 999));

  console.log(`\n⏳  Normalizando multiplicadores del ${from} al ${to} (dryRun=${dryRun})...`);

  try {
    const { processTickets } = await import('../../tools/maintenance/tasks/processTickets');
    await processTickets({
      from: fromDate,
      to: toDate,
      ventanaId,
      normalizeMultipliers: true,
      recalcCommissions: false,
      dryRun,
    });
    console.log(`\n✅  ${colors.brightGreen}Normalización de multiplicadores finalizada.${colors.reset}`);
  } catch (err: any) {
    console.log(`\n❌  Error: ${err.message}`);
  }
}
