import 'dotenv/config';
import { ask, isBack, colors, formatCRC, clearScreen, IS_RENDER, callOpsApi } from './helpers';
import type { TicketPreviewInfo } from '../../domain/ticket/ticketsOps.service';
import { runPurgeWizard } from './purge-cli';
import { tz } from '../../utils/timezone';

/**
 * tickets-cli.ts
 *
 * MÓDULO CLI PARA GESTIÓN DE TICKETS Y VENTAS
 *
 * Opciones:
 * 1. Anulación de Tickets por Consecutivo (Soft-Delete & Resync)
 * 2. Purga Masiva de Tickets y Jugadas Históricas (Batch Chunking & Dry-Run)
 * 3. Sincronizar Estado Cerrado en Tickets Antiguos (isSorteoClosed)
 */

export async function runTicketsWizard() {
  while (true) {
    clearScreen();
    console.log(`======================================================================`);
    console.log(`🎟️   ${colors.bold}${colors.brightCyan}GESTIÓN DE TICKETS Y VENTAS${colors.reset}`);
    console.log(`======================================================================`);
    console.log(`Seleccione una opción:`);
    console.log(`  [1] 🚫  Anulación de Tickets por Consecutivo (Soft-Delete & Resync)`);
    console.log(`  [2] 🗑️   Purga Masiva de Tickets y Jugadas Históricas (Batch Chunking & Dry-Run)`);
    console.log(`  [3] 🔒  Sincronizar Estado Cerrado en Tickets Antiguos (isSorteoClosed)`);
    console.log(`  [B] ⬅️   Volver al Menú Principal`);

    const choice = await ask(`\nOpción (1-3 o B para volver): `);

    if (isBack(choice)) {
      break;
    }

    if (choice === '1') {
      await runTicketCancellationWizard();
      await ask(`\nPresione ENTER para continuar...`);
    } else if (choice === '2') {
      await runPurgeWizard();
      await ask(`\nPresione ENTER para continuar...`);
    } else if (choice === '3') {
      await handleBackfillSorteoClosed();
      await ask(`\nPresione ENTER para continuar...`);
    } else {
      console.log(`❌  Opción no válida.`);
      await ask(`\nPresione ENTER para continuar...`);
    }
  }
}

async function runTicketCancellationWizard() {
  clearScreen();
  console.log(`======================================================================`);
  console.log(`🎟️   ${colors.bold}${colors.brightCyan}ANULACIÓN DE TICKETS POR CONSECUTIVO (SOFT-DELETE & RESYNC)${colors.reset}`);
  console.log(`======================================================================`);
  console.log(`💡  ${colors.dim}Escriba "B" en cualquier momento para regresar al menú anterior.${colors.reset}\n`);

  const input = await ask(`1. Ingrese el consecutivo o números separados por coma\n   (Ej: T260928-03554, T260928-03559): `);

  if (isBack(input) || !input.trim()) {
    return;
  }

  const ticketNumbers = input
    .split(/[,;\s]+/)
    .map(n => n.trim().toUpperCase())
    .filter(Boolean);

  if (ticketNumbers.length === 0) {
    console.log(`❌  No se ingresó ningún número de ticket válido.`);
    return;
  }

  console.log(`\n⏳  Buscando información de los tickets...`);

  let previewList: TicketPreviewInfo[] = [];

  try {
    if (IS_RENDER) {
      const res = await callOpsApi('/tickets/preview', { ticketNumbers });
      previewList = res.tickets || [];
    } else {
      const { TicketsOpsService } = await import('../../domain/ticket/ticketsOps.service');
      previewList = await TicketsOpsService.findTicketsByNumbers(ticketNumbers);
    }
  } catch (err: any) {
    console.log(`\n❌  Error al consultar tickets: ${err.message}`);
    return;
  }

  const foundNumbers = new Set(previewList.map(t => t.ticketNumber));
  const missingNumbers = ticketNumbers.filter(n => !foundNumbers.has(n));

  if (missingNumbers.length > 0) {
    console.log(`\n⚠️   ${colors.brightYellow}Los siguientes tickets NO fueron encontrados en la base de datos:${colors.reset}`);
    missingNumbers.forEach(n => console.log(`    - ${colors.bold}${n}${colors.reset}`));
  }

  if (previewList.length === 0) {
    console.log(`\n❌  Ninguno de los tickets ingresados fue encontrado.`);
    return;
  }

  console.log(`\n📋  ${colors.bold}DETALLE DE LOS TICKETS ENCONTRADOS (${previewList.length}):${colors.reset}`);
  console.log(`----------------------------------------------------------------------`);

  let anyHasPayments = false;
  let anyIsWinner = false;
  let anyAlreadyCancelled = false;
  let anyIsImmutable = false;
  const minOperatingDate = tz.getMinOperatingDateCR();

  previewList.forEach((t, idx) => {
    const isImmutable = t.businessDate < minOperatingDate;
    if (isImmutable) anyIsImmutable = true;

    const isWinnerTag = t.isWinner
      ? ` ${colors.bgYellow}${colors.bold} GANADOR (#${t.sorteo.winningNumber || '?'}) ${colors.reset} ${colors.brightRed}Premio: ${formatCRC(t.totalPayout)}${colors.reset}`
      : ` ${colors.dim}(No premiado)${colors.reset}`;

    const paymentsTag = t.totalPaid > 0 || t.paymentsCount > 0
      ? `\n    🚨 ${colors.bgRed}${colors.bold} ALERTA DE PAGOS: ${colors.reset} ${colors.brightRed}Tiene ${t.paymentsCount} pago(s) registrado(s) por un total de ${formatCRC(t.totalPaid)}.${colors.reset}`
      : '';

    const cancelledTag = t.status === 'CANCELLED' || t.deletedAt !== null
      ? `\n    ⚠️  ${colors.yellow}${colors.bold}ESTADO: YA CANCELADO PREVIAMENTE${colors.reset} (Motivo: ${t.deletedReason || 'N/A'})`
      : '';

    const immutableTag = isImmutable
      ? `\n    🛑 ${colors.bgRed}${colors.bold} HISTORIAL INMUTABLE: ${colors.reset} ${colors.brightRed}La fecha del ticket (${t.businessDate}) supera el límite de ${tz.IMMUTABLE_HISTORY_DAYS} días (${minOperatingDate}). No se puede modificar.${colors.reset}`
      : '';

    if (t.totalPaid > 0 || t.paymentsCount > 0) anyHasPayments = true;
    if (t.isWinner) anyIsWinner = true;
    if (t.status === 'CANCELLED' || t.deletedAt !== null) anyAlreadyCancelled = true;

    console.log(`[${idx + 1}] Ticket: ${colors.bold}${colors.brightCyan}${t.ticketNumber}${colors.reset} │ ID: ${colors.dim}${t.id}${colors.reset}`);
    console.log(`    Fecha Negocio: ${colors.brightYellow}${t.businessDate}${colors.reset} │ Estado: ${t.status} │ Jugadas: ${t.jugadasCount}`);
    console.log(`    Sorteo: ${colors.bold}${t.sorteo.name}${colors.reset} [ID: ${colors.dim}${t.sorteo.id}${colors.reset}] │ Sorteo Estado: ${t.sorteo.status}`);
    console.log(`    Banca: ${colors.bold}${t.banca.name}${colors.reset} │ Ventana: ${colors.bold}${t.ventana.name}${colors.reset} │ Vendedor: ${colors.bold}${t.vendedor.name}${colors.reset}`);
    console.log(`    Venta Total: ${colors.bold}${formatCRC(t.totalAmount)}${colors.reset} │${isWinnerTag}${paymentsTag}${cancelledTag}${immutableTag}`);
    console.log(`----------------------------------------------------------------------`);
  });

  if (anyIsImmutable) {
    console.log(`\n❌  ${colors.brightRed}${colors.bold}OPERACIÓN BLOQUEADA:${colors.reset} Uno o más tickets pertenecen a fechas anteriores a ${minOperatingDate}.`);
    console.log(`    Por integridad financiera y protección contra recálculos históricos, los boletos con más de ${tz.IMMUTABLE_HISTORY_DAYS} días son inmutables.`);
    return;
  }

  if (anyAlreadyCancelled) {
    console.log(`\nℹ️  ${colors.dim}Nota: Los tickets que ya estaban cancelados serán ignorados automáticamente.${colors.reset}`);
  }

  let forceWithPayments = false;
  if (anyHasPayments) {
    console.log(`\n🚨  ${colors.bgRed}${colors.bold} ADVERTENCIA CRÍTICA: UNO O MÁS TICKETS TIENEN PAGOS REGISTRADOS ${colors.reset}`);
    console.log(`    Anular un ticket con pagos eliminará los registros de pago y revertirá el saldo pagado.`);
    const forceInput = await ask(`    ¿Desea forzar la anulación de estos tickets pagados? (si/NO): `);
    if (forceInput.toLowerCase() !== 'si' && forceInput.toLowerCase() !== 's') {
      console.log(`\n❌  Operación cancelada para proteger la integridad financiera.`);
      return;
    }
    forceWithPayments = true;
  }

  const reasonInput = await ask(`\n2. Ingrese el MOTIVO de la anulación (o ENTER para motivo estándar): `);
  if (isBack(reasonInput)) return;
  const reason = reasonInput.trim() || 'Anulación por soporte técnico administrativo';

  const confirm = await ask(`\n⚠️  ¿CONFIRMA ANULAR DEFINITIVAMENTE LOS ${previewList.length} TICKET(S)? (si/no): `);
  if (confirm.toLowerCase() !== 'si' && confirm.toLowerCase() !== 's') {
    console.log(`\n❌  Operación cancelada por el usuario.`);
    return;
  }

  console.log(`\n⏳  Procesando anulación y resincronizando cierres/saldos...`);

  try {
    let result: any;
    if (IS_RENDER) {
      result = await callOpsApi('/tickets/cancel', {
        ticketNumbers: previewList.map(t => t.ticketNumber),
        reason,
        forceWithPayments
      });
    } else {
      const { TicketsOpsService } = await import('../../domain/ticket/ticketsOps.service');
      result = await TicketsOpsService.cancelTickets({
        ticketNumbers: previewList.map(t => t.ticketNumber),
        reason,
        forceWithPayments
      });
    }

    console.log(`\n======================================================================`);
    console.log(`🎉  ${colors.bold}${colors.brightGreen}ANULACIÓN COMPLETADA EXITOSAMENTE${colors.reset}`);
    console.log(`======================================================================`);
    console.log(`📌  Tickets Anulados (${result.cancelledTickets?.length || 0}):`);
    (result.cancelledTickets || []).forEach((t: any) => {
      console.log(`    ✅ ${colors.bold}${t.ticketNumber}${colors.reset} │ Venta deducida: ${formatCRC(t.totalAmount)} │ Premio deducido: ${formatCRC(t.totalPayout)} │ Vendedor: ${t.vendedorName}`);
    });

    if (result.skippedTickets && result.skippedTickets.length > 0) {
      console.log(`\n📌  Tickets Omitidos (${result.skippedTickets.length}):`);
      result.skippedTickets.forEach((t: any) => {
        console.log(`    ⚠️ ${t.ticketNumber}: ${t.reason}`);
      });
    }

    console.log(`\n📊  ${colors.bold}RESINCRONIZACIÓN CONTABLE Y DE AUDITORÍA:${colors.reset}`);
    console.log(`    - Fechas de balance resincronizadas: ${colors.cyan}${result.datesResynced?.join(', ') || 'N/A'}${colors.reset}`);
    console.log(`    - ResumenCierreDiario: ${colors.brightGreen}Recalculado${colors.reset}`);
    console.log(`    - DailyNumberSales (Acopio): ${colors.brightGreen}Reconstruido${colors.reset}`);
    console.log(`    - Arrastre de saldos en AccountStatement: ${colors.brightGreen}Actualizado a hoy${colors.reset}`);
    console.log(`    - ActivityLog: ${colors.brightGreen}Registrado bajo SUPER_ADMIN${colors.reset}`);
    console.log(`======================================================================\n`);

  } catch (err: any) {
    console.log(`\n❌  ERROR AL PROCESAR ANULACIÓN: ${err.message}`);
  }
}

async function handleBackfillSorteoClosed() {
  console.log(`\n🔒  ${colors.bold}SINCRONIZACIÓN DE ESTADO CERRADO EN TICKETS (isSorteoClosed)${colors.reset}`);
  console.log(`----------------------------------------------------------------------`);
  console.log(`Marca isSorteoClosed=true en los tickets pertenecientes a sorteos CLOSED.`);

  const limitInput = await ask(`Límite de sorteos a procesar [ENTER para ilimitado, B para volver]: `);
  if (isBack(limitInput)) return;
  const limit = limitInput.trim() ? parseInt(limitInput, 10) : undefined;

  const dryRunInput = await ask(`¿Ejecutar en modo SIMULACIÓN (dryRun)? (S/n): `);
  const dryRun = dryRunInput.toLowerCase() !== 'n' && dryRunInput.toLowerCase() !== 'no';

  console.log(`\n⏳  Procesando backfill (dryRun=${dryRun})...`);

  try {
    const { backfillSorteoClosed } = await import('../../tools/maintenance/tasks/backfillSorteoClosed');
    await backfillSorteoClosed({ dryRun, limit });
    console.log(`\n✅  ${colors.brightGreen}Sincronización de isSorteoClosed completada.${colors.reset}`);
  } catch (err: any) {
    console.log(`\n❌  Error: ${err.message}`);
  }
}
