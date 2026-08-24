import 'dotenv/config';
import prisma from '../../src/core/prismaClient';
import { crDateService } from '../../src/utils/crDateService';
import SorteoRepository from '../../src/repositories/sorteo.repository';
import { SorteoEvaluationCoordinator } from '../../src/api/v1/services/sorteoEvaluation.coordinator';
import { AccountStatementSyncService } from '../../src/api/v1/services/accounts/accounts.sync.service';
import ActivityService from '../../src/core/activity.service';
import { SorteoStatus, ActivityType } from '../../src/generated/prisma/client';
import { ask, isBack, colors, colorizeStatus, colorizeSorteoId, colorizeWinningNumber, clearScreen } from './helpers';
import logger from '../../src/core/logger';

// Silenciar logger interno
logger.level = 'error';

/**
 * sorteos-cli.ts
 *
 * Asistente interactivo de sorteos (Evaluar, Revertir, Cerrar, Reabrir) con pantalla limpia y resaltado ANSI.
 * Registra auditorías automáticas en ActivityLog.
 */

export async function runSorteosWizard() {
  let currentStep = 1;
  let targetDate = crDateService.dateUTCToCRString(new Date());
  let startOfDayUTC = new Date();
  let endOfDayUTC = new Date();

  let bancas: any[] = [];
  let selectedBanca: any = null;

  let loteriasRaw: any[] = [];
  let uniqueLoteriaNames: string[] = [];
  let selectedLoteriaName: string | null = null;
  let matchingLoteriaIds: string[] = [];

  let sorteos: any[] = [];

  while (currentStep > 0 && currentStep <= 5) {
    if (currentStep === 1) {
      clearScreen();
      console.log(`======================================================================`);
      console.log(`🎰  ${colors.bold}${colors.brightCyan}ASISTENTE INTERACTIVO DE SORTEOS (EVALUAR / REVERTIR / CERRAR / REABRIR)${colors.reset}`);
      console.log(`======================================================================`);
      console.log(`💡  ${colors.dim}Escriba "b" en cualquier momento para regresar.${colors.reset}\n`);

      const todayCR = crDateService.dateUTCToCRString(new Date());
      const inputDate = await ask(`1. Ingrese la fecha (YYYY-MM-DD) [ENTER para hoy (${todayCR})]: `);

      if (isBack(inputDate)) {
        currentStep = 0;
        break;
      }

      targetDate = inputDate || todayCR;
      const [year, month, day] = targetDate.split('-').map(Number);
      startOfDayUTC = new Date(Date.UTC(year, month - 1, day, 6, 0, 0, 0));
      endOfDayUTC = new Date(Date.UTC(year, month - 1, day + 1, 5, 59, 59, 999));

      currentStep = 2;
    } else if (currentStep === 2) {
      clearScreen();
      console.log(`======================================================================`);
      console.log(`🎰  ${colors.bold}${colors.brightCyan}ASISTENTE DE SORTEOS │ FECHA: ${targetDate}${colors.reset}`);
      console.log(`======================================================================\n`);

      bancas = await prisma.banca.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' }
      });

      console.log(`2. Seleccione la Banca Multi-Tenant:`);
      console.log(`   [0] Todas las Bancas / Global`);
      bancas.forEach((b, index) => {
        console.log(`   [${index + 1}] ${colors.bold}${b.name}${colors.reset} [ID: ${colors.cyan}${b.id}${colors.reset}]`);
      });
      console.log(`   [B] ⬅️  Volver a selección de Fecha`);

      const bancaChoice = await ask(`\n   Opción (0-${bancas.length} o B para volver): `);
      if (isBack(bancaChoice)) {
        currentStep = 1;
        continue;
      }

      const selectedBancaIndex = parseInt(bancaChoice, 10);
      selectedBanca = (!isNaN(selectedBancaIndex) && selectedBancaIndex > 0 && selectedBancaIndex <= bancas.length)
        ? bancas[selectedBancaIndex - 1]
        : null;

      currentStep = 3;
    } else if (currentStep === 3) {
      clearScreen();
      console.log(`======================================================================`);
      console.log(`🎰  ${colors.bold}${colors.brightCyan}ASISTENTE DE SORTEOS │ FECHA: ${targetDate} │ BANCA: ${selectedBanca ? selectedBanca.name : 'TODAS'}${colors.reset}`);
      console.log(`======================================================================\n`);

      loteriasRaw = await prisma.loteria.findMany({
        where: {
          isActive: true,
          ...(selectedBanca ? { OR: [{ bancaId: selectedBanca.id }, { bancaId: null }] } : {})
        },
        select: { id: true, name: true, bancaId: true },
        orderBy: { name: 'asc' }
      });

      uniqueLoteriaNames = Array.from(new Set(loteriasRaw.map(l => l.name))).sort();

      console.log(`3. Seleccione la Lotería:`);
      console.log(`   [0] Todas las Loterías`);
      uniqueLoteriaNames.forEach((name, index) => {
        console.log(`   [${index + 1}] ${colors.bold}${name}${colors.reset}`);
      });
      console.log(`   [B] ⬅️  Volver a selección de Banca`);

      const loteriaChoice = await ask(`\n   Opción (0-${uniqueLoteriaNames.length} o B para volver): `);
      if (isBack(loteriaChoice)) {
        currentStep = 2;
        continue;
      }

      const selectedLoteriaIndex = parseInt(loteriaChoice, 10);
      selectedLoteriaName = (!isNaN(selectedLoteriaIndex) && selectedLoteriaIndex > 0 && selectedLoteriaIndex <= uniqueLoteriaNames.length)
        ? uniqueLoteriaNames[selectedLoteriaIndex - 1]
        : null;

      matchingLoteriaIds = selectedLoteriaName
        ? loteriasRaw.filter(l => l.name === selectedLoteriaName).map(l => l.id)
        : [];

      currentStep = 4;
    } else if (currentStep === 4) {
      clearScreen();
      console.log(`======================================================================`);
      console.log(`📋  ${colors.bold}SORTEOS ENCONTRADOS PARA EL ${targetDate} │ BANCA: ${selectedBanca ? selectedBanca.name : 'TODAS'} │ LOTERÍA: ${selectedLoteriaName || 'TODAS'}${colors.reset}`);
      console.log(`======================================================================\n`);

      sorteos = await prisma.sorteo.findMany({
        where: {
          scheduledAt: { gte: startOfDayUTC, lte: endOfDayUTC },
          isActive: true,
          ...(selectedBanca ? { bancaId: selectedBanca.id } : {}),
          ...(matchingLoteriaIds.length > 0 ? { loteriaId: { in: matchingLoteriaIds } } : {}),
        },
        include: {
          loteria: { select: { id: true, name: true } },
          banca: { select: { id: true, name: true } },
          extraMultiplier: { select: { id: true, name: true, valueX: true } }
        },
        orderBy: { scheduledAt: 'asc' }
      });

      if (sorteos.length === 0) {
        console.log(`⚠️  No se encontraron sorteos para los criterios seleccionados.`);
        const retryChoice = await ask(`\n   [B] ⬅️  Volver a Loterías | [0] Salir: `);
        if (isBack(retryChoice)) {
          currentStep = 3;
          continue;
        } else {
          currentStep = 0;
          break;
        }
      }

      sorteos.forEach((s, index) => {
        const timeFormatted = new Date(s.scheduledAt).toLocaleTimeString('es-CR', {
          timeZone: 'America/Costa_Rica',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        });

        const statusColored = colorizeStatus(s.status);
        const idColored = colorizeSorteoId(s.id);
        const numColored = colorizeWinningNumber(s.winningNumber);

        console.log(`[${colors.bold}${index + 1}${colors.reset}] Sorteo: ${colors.bold}${colors.brightGreen}${s.name}${colors.reset} (${s.loteria?.name || 'N/A'})`);
        console.log(`    ID: ${idColored}`);
        console.log(`    Banca: ${colors.bold}${s.banca?.name || 'Global'}${colors.reset} [bancaId: ${colors.dim}${s.bancaId || 'null'}${colors.reset}] │ Hora: ${colors.brightYellow}${timeFormatted}${colors.reset} │ Estado: ${statusColored} │ Número: ${numColored}`);
        if (s.extraMultiplier) console.log(`    Reventado DB: ${colors.brightMagenta}${s.extraMultiplier.name} (${s.extraMultiplier.valueX}X)${colors.reset} [ID: ${colors.dim}${s.extraMultiplier.id}${colors.reset}]`);
        console.log(``);
      });

      console.log(`----------------------------------------------------------------------`);
      console.log(`¿Desea ejecutar una acción de soporte sobre alguno de estos sorteos?`);
      console.log(`  [1] Evaluar Sorteo`);
      console.log(`  [2] Revertir Evaluación`);
      console.log(`  [3] Cerrar Sorteo`);
      console.log(`  [4] Reabrir Sorteo Cerrado (CLOSED ➔ OPEN)`);
      console.log(`  [B] ⬅️  Volver a selección de Lotería`);
      console.log(`  [0] Salir (Finalizar)`);

      const actionChoice = await ask(`\nSeleccione Acción (0-4 o B para volver): `);
      if (isBack(actionChoice)) {
        currentStep = 3;
        continue;
      }

      const actionOption = parseInt(actionChoice, 10);
      if (isNaN(actionOption) || actionOption === 0) {
        currentStep = 0;
        break;
      }

      const sorteoTargetInput = await ask(`Seleccione el número de Sorteo (1-${sorteos.length} o B para cancelar): `);
      if (isBack(sorteoTargetInput)) continue;

      const sorteoIndex = parseInt(sorteoTargetInput, 10) - 1;
      if (isNaN(sorteoIndex) || sorteoIndex < 0 || sorteoIndex >= sorteos.length) {
        console.log(`❌  Número de sorteo inválido.`);
        continue;
      }

      const targetSorteo = sorteos[sorteoIndex];

      if (actionOption === 1) {
        if (targetSorteo.status !== SorteoStatus.OPEN) {
          console.log(`❌  El sorteo debe estar en estado OPEN para evaluar (Estado actual: ${targetSorteo.status}).`);
          continue;
        }
        const winningNumber = await ask(`Ingrese el Número Ganador: `);
        if (!winningNumber) {
          console.log(`❌  Número ganador requerido.`);
          continue;
        }

        const extraMultipliers = await prisma.loteriaMultiplier.findMany({
          where: {
            loteriaId: targetSorteo.loteriaId,
            kind: 'REVENTADO',
            isActive: true,
            OR: [{ bancaId: targetSorteo.bancaId }, { bancaId: null }]
          },
          select: { id: true, name: true, valueX: true }
        });

        let chosenMultiplierId: string | undefined = undefined;
        if (extraMultipliers.length > 0) {
          console.log(`\nSeleccione el Multiplicador Reventado:`);
          console.log(`  [0] Ninguno / Bolita Blanca`);
          extraMultipliers.forEach((m, i) => {
            console.log(`  [${i + 1}] ${colors.bold}${m.name}${colors.reset} (${m.valueX}X) [ID: ${colors.dim}${m.id}${colors.reset}]`);
          });
          const mulChoice = await ask(`  Opción (0-${extraMultipliers.length}): `);
          const mulIndex = parseInt(mulChoice, 10) - 1;
          if (!isNaN(mulIndex) && mulIndex >= 0 && mulIndex < extraMultipliers.length) {
            chosenMultiplierId = extraMultipliers[mulIndex].id;
          }
        }

        console.log(`\n⏳  Procesando evaluación...`);
        const { extraOutcomeCode } = await SorteoEvaluationCoordinator.validate(
          targetSorteo.id,
          { winningNumber, extraMultiplierId: chosenMultiplierId || null },
          targetSorteo
        );

        const evaluated = await SorteoRepository.evaluate(targetSorteo.id, {
          winningNumber: winningNumber.trim(),
          extraOutcomeCode,
          extraMultiplierId: chosenMultiplierId || null
        });

        if (!evaluated) throw new Error("Error al evaluar en base de datos.");

        await SorteoEvaluationCoordinator.triggerPostEvaluation(
          targetSorteo.id,
          winningNumber.trim(),
          chosenMultiplierId || null,
          targetSorteo,
          evaluated,
          "CLI_WIZARD"
        );

        console.log(`\n🎉  ${colors.bold}${colors.brightGreen}EVALUACIÓN COMPLETADA EXITOSAMENTE.${colors.reset} Sync encolado.`);
        currentStep = 0;
        break;
      } else if (actionOption === 2) {
        if (targetSorteo.status !== SorteoStatus.EVALUATED) {
          console.log(`❌  El sorteo debe estar en estado EVALUATED para revertir (Estado actual: ${targetSorteo.status}).`);
          continue;
        }
        const confirm = await ask(`⚠️  ¿CONFIRMA REVERTIR EL SORTEO ${colors.bold}${targetSorteo.name}${colors.reset}? (si/no): `);
        if (confirm.toLowerCase() !== 'si' && confirm.toLowerCase() !== 's') {
          console.log(`❌  Operación cancelada.`);
          continue;
        }
        console.log(`\n⏳  Revertiendo sorteo y reacondicionando saldos...`);
        await SorteoRepository.revertEvaluation(targetSorteo.id);
        await AccountStatementSyncService.syncSorteoStatements(targetSorteo.id, targetSorteo.scheduledAt);

        // Registrar en ActivityLog
        await ActivityService.log({
          action: ActivityType.SYSTEM_ACTION,
          targetType: 'SORTEO',
          targetId: targetSorteo.id,
          bancaId: targetSorteo.bancaId || null,
          details: {
            source: 'CLI_MAIN_WIZARD',
            module: 'REVERT_SORTEO',
            sorteoName: targetSorteo.name,
            scheduledAt: targetSorteo.scheduledAt,
            executedBy: 'SUPER_ADMIN'
          }
        });

        console.log(`\n🎉  ${colors.bold}${colors.brightGreen}REVERSIÓN COMPLETADA Y REGISTRADA EN LOGS EXITOSAMENTE.${colors.reset}`);
        currentStep = 0;
        break;
      } else if (actionOption === 3) {
        const confirm = await ask(`⚠️  ¿CONFIRMA CERRAR EL SORTEO ${colors.bold}${targetSorteo.name}${colors.reset}? (si/no): `);
        if (confirm.toLowerCase() !== 'si' && confirm.toLowerCase() !== 's') {
          console.log(`❌  Operación cancelada.`);
          continue;
        }
        const { ticketsAffected } = await SorteoRepository.closeWithCascade(targetSorteo.id);

        // Registrar en ActivityLog
        await ActivityService.log({
          action: ActivityType.SORTEO_CLOSE,
          targetType: 'SORTEO',
          targetId: targetSorteo.id,
          bancaId: targetSorteo.bancaId || null,
          details: {
            source: 'CLI_MAIN_WIZARD',
            module: 'CLOSE_SORTEO',
            sorteoName: targetSorteo.name,
            ticketsAffected,
            executedBy: 'SUPER_ADMIN'
          }
        });

        console.log(`\n🎉  ${colors.bold}${colors.brightGreen}SORTEO CERRADO Y REGISTRADO EN LOGS EXITOSAMENTE${colors.reset} (${ticketsAffected} tickets afectados).`);
        currentStep = 0;
        break;
      } else if (actionOption === 4) {
        if (targetSorteo.status !== SorteoStatus.CLOSED && targetSorteo.deletedAt === null) {
          console.log(`❌  El sorteo no está cerrado ni eliminado (Estado actual: ${targetSorteo.status}).`);
          continue;
        }
        const confirm = await ask(`⚠️  ¿CONFIRMA REABRIR EL SORTEO CERRADO ${colors.bold}${targetSorteo.name}${colors.reset}? (si/no): `);
        if (confirm.toLowerCase() !== 'si' && confirm.toLowerCase() !== 's') {
          console.log(`❌  Operación cancelada.`);
          continue;
        }
        console.log(`\n⏳  Reabriendo sorteo y reactivando tickets...`);
        await SorteoRepository.restore(targetSorteo.id);

        // Registrar en ActivityLog
        await ActivityService.log({
          action: ActivityType.SORTEO_REOPEN,
          targetType: 'SORTEO',
          targetId: targetSorteo.id,
          bancaId: targetSorteo.bancaId || null,
          details: {
            source: 'CLI_MAIN_WIZARD',
            module: 'REOPEN_SORTEO',
            sorteoName: targetSorteo.name,
            executedBy: 'SUPER_ADMIN'
          }
        });

        console.log(`\n🎉  ${colors.bold}${colors.brightGreen}SORTEO REABIERTO Y REGISTRADO EN LOGS EXITOSAMENTE.${colors.reset}`);
        currentStep = 0;
        break;
      }
    }
  }
}
