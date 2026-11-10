import 'dotenv/config';
import { ask, isBack, colors, clearScreen, renderProgressBar, IS_RENDER, callOpsApi } from './helpers';
import type { PurgeSummaryResult, PurgeProgressInfo } from '../../tools/maintenance/tasks/purgeTickets';

/**
 * purge-cli.ts
 *
 * MÓDULO CLI PARA PURGA MASIVA Y SEGURA DE TICKETS Y JUGADAS HISTÓRICAS (BATCH CHUNKING)
 *
 * Características:
 * - Auditoría previa obligatoria (--dry-run) con conteo de Tickets, Jugadas y Pagos.
 * - Validación estricta con confirmación manual ("CONFIRMAR").
 * - Borrado por lotes (Batch Chunking) para no saturar WAL ni locks en producción.
 * - Pausas de cortesía entre lotes (100ms) para garantizar 0 impacto en ventas concurrentes.
 * - Compatible con Render HTTP API y ejecución local con Prisma.
 */

export async function runPurgeWizard() {
  clearScreen();
  console.log(`======================================================================`);
  console.log(`🗑️   ${colors.bold}${colors.brightCyan}PURGA MASIVA DE TICKETS Y JUGADAS HISTÓRICAS (BATCH CHUNKING)${colors.reset}`);
  console.log(`======================================================================`);
  console.log(`💡  ${colors.dim}Esta herramienta elimina tickets y jugadas cerrados anteriores a una fecha de corte.${colors.reset}`);
  console.log(`    ${colors.dim}La contabilidad consolidada (AccountStatement, ResumenCierreDiario) queda 100% intacta.${colors.reset}`);
  console.log(`    ${colors.dim}Escriba "B" en cualquier momento para regresar al menú principal.${colors.reset}\n`);

  // 1. Solicitar fecha límite
  const defaultBeforeDate = '2026-04-30';
  const inputDate = await ask(
    `📅  Ingrese la fecha de corte (YYYY-MM-DD)\n    [ENTER para ${colors.brightYellow}${defaultBeforeDate}${colors.reset} (conservar 6 meses de histórico + mes actual), B para volver]: `
  );

  if (isBack(inputDate)) {
    return;
  }

  const beforeDate = (inputDate || defaultBeforeDate).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(beforeDate)) {
    console.log(`\n❌  Formato de fecha inválido. Debe ser YYYY-MM-DD.`);
    return;
  }

  // 2. Solicitar tamaño de lote
  const inputBatch = await ask(
    `📦  Tamaño de lote de tickets por transacción [ENTER para ${colors.brightCyan}2500${colors.reset}, B para volver]: `
  );

  if (isBack(inputBatch)) {
    return;
  }

  const batchSize = parseInt(inputBatch, 10) || 2500;
  if (batchSize < 100 || batchSize > 10000) {
    console.log(`\n❌  El tamaño de lote debe estar entre 100 y 10,000 tickets.`);
    return;
  }

  console.log(`\n⏳  Analizando base de datos en modo SIMULACIÓN (dryRun)...`);

  let preview: PurgeSummaryResult;

  try {
    if (IS_RENDER) {
      const res = await callOpsApi('/purge/preview', { beforeDate });
      preview = res.preview;
    } else {
      const { purgeTickets } = await import('../../tools/maintenance/tasks/purgeTickets');
      preview = await purgeTickets({ beforeDate, dryRun: true, batchSize });
    }
  } catch (err: any) {
    console.log(`\n❌  Error al auditar la base de datos: ${err.message}`);
    return;
  }

  console.log(`\n======================================================================`);
  console.log(`📋  ${colors.bold}RESULTADOS DE LA AUDITORÍA PREVIA (SIMULACIÓN):${colors.reset}`);
  console.log(`======================================================================`);
  console.log(`  📅  Fecha de corte evaluada:      ${colors.brightYellow}<= ${beforeDate}${colors.reset}`);
  console.log(`  📍  Rango real de datos detectado: ${colors.bold}${preview.minDate || 'N/A'}${colors.reset} hasta ${colors.bold}${preview.maxDate || 'N/A'}${colors.reset}`);
  console.log(`----------------------------------------------------------------------`);
  console.log(`  🎟️   Tickets a eliminar:           ${colors.bold}${colors.brightCyan}${preview.identified.toLocaleString()}${colors.reset}`);
  console.log(`  🎲  Jugadas a eliminar:           ${colors.bold}${colors.brightMagenta}${preview.identifiedJugadas.toLocaleString()}${colors.reset}`);
  console.log(`  💳  Pagos de tickets a eliminar:  ${colors.bold}${colors.brightYellow}${preview.identifiedPayments.toLocaleString()}${colors.reset}`);
  console.log(`----------------------------------------------------------------------`);
  console.log(`  📦  Lotes estimados:             ${colors.bold}${preview.totalBatches}${colors.reset} (de ${batchSize} tickets c/u)`);
  console.log(`  ⏱️   Tiempo estimado aprox:        ${colors.bold}~${Math.ceil((preview.totalBatches * 0.4) / 60)} min${colors.reset} (con pausas de 100ms)`);
  console.log(`======================================================================\n`);

  if (preview.identified === 0) {
    console.log(`✅  No existen tickets ni jugadas para eliminar anteriores a ${beforeDate}.`);
    return;
  }

  console.log(`⚠️   ${colors.bgRed}${colors.bold} ADVERTENCIA DE SEGURIDAD ${colors.reset}`);
  console.log(`    Esta acción eliminará definitivamente los ${preview.identified.toLocaleString()} tickets y sus ${preview.identifiedJugadas.toLocaleString()} jugadas.`);
  console.log(`    Asegúrese de haber verificado que cuenta con un respaldo reciente de la base de datos.`);
  console.log(`    Los balances contables en AccountStatement y cierres diarios NO serán afectados.\n`);

  const confirmInput = await ask(
    `🔒  Para proceder con la purga real, escriba exactamente "${colors.bold}${colors.brightRed}CONFIRMAR${colors.reset}" (o cualquier otra tecla para cancelar): `
  );

  if (confirmInput.trim() !== 'CONFIRMAR') {
    console.log(`\n❌  Operación cancelada por el usuario. No se ha modificado ningún dato.`);
    return;
  }

  console.log(`\n🚀  ${colors.bold}${colors.brightGreen}Iniciando purga real en lotes controlados...${colors.reset}\n`);

  let outcome: PurgeSummaryResult;
  const startTime = Date.now();

  try {
    if (IS_RENDER) {
      console.log(`⏳  Ejecutando en servidor interno (Render Mode). Espere a que finalicen los lotes...`);
      const res = await callOpsApi('/purge/execute', { beforeDate, batchSize });
      outcome = res.result;
    } else {
      const { purgeTickets } = await import('../../tools/maintenance/tasks/purgeTickets');

      outcome = await purgeTickets({
        beforeDate,
        dryRun: false,
        batchSize,
        sleepMs: 100,
        onProgress: (p: PurgeProgressInfo) => {
          renderProgressBar(
            p.batchIndex,
            p.totalBatches,
            `Lote ${p.batchIndex}/${p.totalBatches} (${p.deletedTickets.toLocaleString()} tkts)`
          );
        },
      });
      process.stdout.write('\n');
    }
  } catch (err: any) {
    console.log(`\n❌  Error durante la ejecución de la purga: ${err.message}`);
    return;
  }

  const durationSec = Math.round((Date.now() - startTime) / 1000);

  console.log(`\n======================================================================`);
  console.log(`🎉  ${colors.bold}${colors.brightGreen}PURGA COMPLETADA EXITOSAMENTE${colors.reset}`);
  console.log(`======================================================================`);
  console.log(`  🎟️   Tickets eliminados:          ${colors.bold}${outcome.deletedTickets.toLocaleString()}${colors.reset}`);
  console.log(`  🎲  Jugadas eliminadas:          ${colors.bold}${outcome.deletedJugadas.toLocaleString()}${colors.reset}`);
  console.log(`  💳  Pagos eliminados:            ${colors.bold}${outcome.deletedPayments.toLocaleString()}${colors.reset}`);
  console.log(`  🔢  Contadores limpiados:        ${colors.bold}${outcome.deletedCounters.toLocaleString()}${colors.reset}`);
  console.log(`  ⏱️   Duración total:              ${colors.bold}${durationSec} segundos${colors.reset} (${outcome.totalBatches} lotes)`);
  console.log(`======================================================================`);
  console.log(`\n💡  ${colors.bold}Recomendación de mantenimiento post-purga:${colors.reset}`);
  console.log(`    Para recuperar el espacio en disco y descompactar índices en PostgreSQL,`);
  console.log(`    ejecute en horario valle en Supabase SQL Editor:`);
  console.log(`    ${colors.brightCyan}VACUUM ANALYZE "Ticket";${colors.reset}`);
  console.log(`    ${colors.brightCyan}VACUUM ANALYZE "Jugada";${colors.reset}`);
  console.log(`    ${colors.brightCyan}REINDEX INDEX CONCURRENTLY "idx_jugada_maestro_final";${colors.reset}\n`);
}
