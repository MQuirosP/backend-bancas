import 'dotenv/config';
import { ask, isBack, colors, formatCRC, clearScreen, IS_RENDER, callOpsApi } from './helpers';
import { TicketsOpsService, TicketPreviewInfo } from '../../domain/ticket/ticketsOps.service';

/**
 * tickets-cli.ts
 *
 * MÓDULO CLI PARA ANULACIÓN / BORRADO CONTROLADO DE TICKETS POR CONSECUTIVO (TICKET NUMBER)
 *
 * Características:
 * - Inspección previa detallada con métricas de venta, comisiones, premios y pagos.
 * - Advertencias de seguridad si el ticket ya fue pagado o si el sorteo ya fue evaluado.
 * - Soft-delete atómico en base de datos (inactiva ticket y jugadas asociadas).
 * - Ajuste inteligente de `hasWinner` en Sorteo si correspondía al único ganador.
 * - Re-agregación de acopio (DailyNumberSales) y rollups (ResumenCierreDiario).
 * - Re-sincronización en cadena del libro contable (AccountStatement) y arrastre de saldos hasta hoy.
 * - Compatible con Render HTTP API y ejecución local con Prisma.
 */

export async function runTicketsWizard() {
  clearScreen();
  console.log(`======================================================================`);
  console.log(`🎟️   ${colors.bold}${colors.brightCyan}ANULACIÓN DE TICKETS POR CONSECUTIVO (SOFT-DELETE & RESYNC)${colors.reset}`);
  console.log(`======================================================================`);
  console.log(`💡  ${colors.dim}Escriba "B" en cualquier momento para regresar al menú principal.${colors.reset}\n`);

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

  previewList.forEach((t, idx) => {
    const isWinnerTag = t.isWinner
      ? ` ${colors.bgYellow}${colors.bold} GANADOR (#${t.sorteo.winningNumber || '?'}) ${colors.reset} ${colors.brightRed}Premio: ${formatCRC(t.totalPayout)}${colors.reset}`
      : ` ${colors.dim}(No premiado)${colors.reset}`;

    const paymentsTag = t.totalPaid > 0 || t.paymentsCount > 0
      ? `\n    🚨 ${colors.bgRed}${colors.bold} ALERTA DE PAGOS: ${colors.reset} ${colors.brightRed}Tiene ${t.paymentsCount} pago(s) registrado(s) por un total de ${formatCRC(t.totalPaid)}.${colors.reset}`
      : '';

    const cancelledTag = t.status === 'CANCELLED' || t.deletedAt !== null
      ? `\n    ⚠️  ${colors.yellow}${colors.bold}ESTADO: YA CANCELADO PREVIAMENTE${colors.reset} (Motivo: ${t.deletedReason || 'N/A'})`
      : '';

    if (t.totalPaid > 0 || t.paymentsCount > 0) anyHasPayments = true;
    if (t.isWinner) anyIsWinner = true;
    if (t.status === 'CANCELLED' || t.deletedAt !== null) anyAlreadyCancelled = true;

    console.log(`[${idx + 1}] Ticket: ${colors.bold}${colors.brightCyan}${t.ticketNumber}${colors.reset} │ ID: ${colors.dim}${t.id}${colors.reset}`);
    console.log(`    Fecha Negocio: ${colors.brightYellow}${t.businessDate}${colors.reset} │ Estado: ${t.status} │ Jugadas: ${t.jugadasCount}`);
    console.log(`    Sorteo: ${colors.bold}${t.sorteo.name}${colors.reset} [ID: ${colors.dim}${t.sorteo.id}${colors.reset}] │ Sorteo Estado: ${t.sorteo.status}`);
    console.log(`    Banca: ${colors.bold}${t.banca.name}${colors.reset} │ Ventana: ${colors.bold}${t.ventana.name}${colors.reset} │ Vendedor: ${colors.bold}${t.vendedor.name}${colors.reset}`);
    console.log(`    Venta Total: ${colors.bold}${formatCRC(t.totalAmount)}${colors.reset} │${isWinnerTag}${paymentsTag}${cancelledTag}`);
    console.log(`----------------------------------------------------------------------`);
  });

  if (anyAlreadyCancelled && previewList.every(t => t.status === 'CANCELLED' || t.deletedAt !== null)) {
    console.log(`\n⚠️  Todos los tickets seleccionados ya están cancelados. No hay acciones que ejecutar.`);
    return;
  }

  // Advertencias críticas
  if (anyHasPayments) {
    console.log(`\n🚨  ${colors.bgRed}${colors.bold} ATENCIÓN CRÍTICA: PAGOS REGISTRADOS ${colors.reset}`);
    console.log(`    Al menos uno de los tickets tiene pagos registrados. Anularlo eliminará esos registros de pago y revertirá los balances.`);
  }

  if (anyIsWinner) {
    console.log(`\n💡  ${colors.brightYellow}${colors.bold}NOTA CONTABLE: PREMIOS ASIGNADOS ${colors.reset}`);
    console.log(`    Se anularán los premios ganados y se recalcularán los cierres y el arrastre de saldos hasta hoy para que no afecten el balance.`);
  }

  const confirmChoice = await ask(`\n⚠️  ¿CONFIRMA PROCEDER CON LA ANULACIÓN? (si/no): `);
  if (confirmChoice.toLowerCase() !== 'si' && confirmChoice.toLowerCase() !== 's') {
    console.log(`❌  Operación cancelada por el usuario.`);
    return;
  }

  let forceWithPayments = false;
  if (anyHasPayments) {
    const forceChoice = await ask(`⚠️  Re-confirme: ¿Desea ELIMINAR los pagos registrados de estos tickets y forzar anulación? (si/no): `);
    if (forceChoice.toLowerCase() !== 'si' && forceChoice.toLowerCase() !== 's') {
      console.log(`❌  Operación cancelada.`);
      return;
    }
    forceWithPayments = true;
  }

  const reasonInput = await ask(`\n📝  Ingrese el motivo de la anulación [ENTER para 'Anulación de soporte técnico por error de digitación']: `);
  const reason = reasonInput.trim() || 'Anulación de soporte técnico por error de digitación';

  console.log(`\n⏳  Procesando anulación y resincronización contable (Rollups, Statements y Acopio)...`);

  try {
    let result: any;
    if (IS_RENDER) {
      result = await callOpsApi('/tickets/cancel', {
        ticketNumbers,
        reason,
        forceWithPayments
      });
    } else {
      result = await TicketsOpsService.cancelTickets({
        ticketNumbers,
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
