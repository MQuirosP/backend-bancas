import 'dotenv/config';
import { ask, isBack, colors, formatCRC, clearScreen, IS_RENDER, callOpsApi } from './helpers';
import { VendorOpsService, VendorAuditInfo } from '../../domain/accounts/vendorOps.service';

/**
 * vendor-ops-cli.ts
 *
 * MÓDULO CLI PARA TRASLADOS Y LIQUIDACIÓN / AJUSTE DE SALDOS DE VENDEDORES ENTRE BANCAS
 *
 * Características:
 * - Búsqueda interactiva de vendedores por nombre, código o usuario.
 * - Desglose y auditoría de saldo actual e histórico en todas las bancas.
 * - Traslado atómico de vendedor entre bancas y ventanas con 3 modos de saldo:
 *    1) Iniciar en 0 (Borrón y cuenta nueva).
 *    2) Arrastrar saldo actual (Carry-over) con opción de liquidar origen.
 *    3) Saldo personalizado.
 * - Ajuste y corrección de saldo de partida en bancas específicas.
 * - Invalidación proactiva reactiva de caché (Regla 14: CacheService y accountStatementCache).
 * - Compatible con Render HTTP API (límite 100MB) y ejecución directa con Prisma en local.
 */

async function fetchBancas(): Promise<Array<{ id: string; name: string }>> {
  if (IS_RENDER) {
    const res = await callOpsApi('/vendor/bancas', {});
    return res.bancas || [];
  }
  return await VendorOpsService.listBancas();
}

async function fetchVentanas(bancaId: string): Promise<Array<{ id: string; name: string; bancaId: string }>> {
  if (IS_RENDER) {
    const res = await callOpsApi('/vendor/ventanas', { bancaId });
    return res.ventanas || [];
  }
  return await VendorOpsService.listVentanas(bancaId);
}

async function searchVendorsApi(query: string): Promise<any[]> {
  if (IS_RENDER) {
    const res = await callOpsApi('/vendor/search', { query });
    return res.vendors || [];
  }
  return await VendorOpsService.searchVendors(query);
}

async function getVendorAuditApi(vendedorId: string): Promise<VendorAuditInfo> {
  if (IS_RENDER) {
    const res = await callOpsApi('/vendor/audit', { vendedorId });
    return res.audit;
  }
  return await VendorOpsService.getVendorAudit(vendedorId);
}

async function transferVendorApi(params: any): Promise<any> {
  if (IS_RENDER) {
    const res = await callOpsApi('/vendor/transfer', params);
    return res.result;
  }
  return await VendorOpsService.transferVendor(params);
}

async function adjustVendorBalanceApi(params: any): Promise<any> {
  if (IS_RENDER) {
    const res = await callOpsApi('/vendor/adjust-balance', params);
    return res.result;
  }
  return await VendorOpsService.adjustBalance(params);
}

export async function runVendorOpsWizard() {
  while (true) {
    clearScreen();
    console.log(`======================================================================`);
    console.log(`🔄  ${colors.bold}${colors.brightCyan}TRASLADO Y LIQUIDACIÓN DE VENDEDORES (VENDOR OPS)${colors.reset}`);
    console.log(`======================================================================`);
    console.log(`💡  ${colors.dim}Escriba "B" en cualquier momento para regresar al menú principal.${colors.reset}\n`);

    const query = await ask(`1. Ingrese el nombre, usuario o código del vendedor a buscar\n   [ENTER para listar los primeros 50, B para volver]: `);
    if (isBack(query)) return;

    console.log(`\n⏳  Buscando vendedores...`);
    let vendors: any[] = [];
    try {
      vendors = await searchVendorsApi(query);
    } catch (err: any) {
      console.log(`❌  Error al buscar vendedores: ${err.message}`);
      await ask(`\nPresione ENTER para continuar...`);
      continue;
    }

    if (vendors.length === 0) {
      console.log(`❌  No se encontraron vendedores que coincidan con la búsqueda.`);
      await ask(`\nPresione ENTER para reintentar...`);
      continue;
    }

    console.log(`\n📋  ${colors.bold}VENDEDORES ENCONTRADOS (${vendors.length}):${colors.reset}`);
    console.log(`----------------------------------------------------------------------`);
    vendors.forEach((v, idx) => {
      const bName = v.banca?.name || `${colors.red}Sin Banca${colors.reset}`;
      const vName = v.ventana?.name || `${colors.red}Sin Ventana${colors.reset}`;
      const status = v.isActive ? `${colors.brightGreen}Activo${colors.reset}` : `${colors.dim}Inactivo${colors.reset}`;
      console.log(`  [${idx + 1}] ${colors.bold}${v.name}${colors.reset} (@${v.username || 'sin_usuario'}) │ Código: ${colors.brightCyan}${v.code || 'N/A'}${colors.reset} │ Estado: ${status}`);
      console.log(`      Banca: ${colors.bold}${bName}${colors.reset} │ Listero/Ventana: ${colors.bold}${vName}${colors.reset} │ ID: ${colors.dim}${v.id}${colors.reset}`);
    });
    console.log(`  [B] ⬅️  Volver`);

    const selection = await ask(`\nSeleccione el número del vendedor (1-${vendors.length}): `);
    if (isBack(selection)) return;

    const sIdx = parseInt(selection, 10);
    if (isNaN(sIdx) || sIdx < 1 || sIdx > vendors.length) {
      console.log(`❌  Selección no válida.`);
      await ask(`\nPresione ENTER para continuar...`);
      continue;
    }

    const selectedVendor = vendors[sIdx - 1];
    await handleVendorActions(selectedVendor.id);
  }
}

async function handleVendorActions(vendedorId: string) {
  while (true) {
    clearScreen();
    console.log(`\n⏳  Cargando auditoría y posición financiera del vendedor...`);
    let audit: VendorAuditInfo;
    try {
      audit = await getVendorAuditApi(vendedorId);
    } catch (err: any) {
      console.log(`❌  Error al obtener auditoría: ${err.message}`);
      await ask(`\nPresione ENTER para volver...`);
      return;
    }

    clearScreen();
    console.log(`======================================================================`);
    console.log(`👤  ${colors.bold}${colors.brightCyan}DETALLE Y AUDITORÍA DE: ${audit.name} (@${audit.username || 'N/A'})${colors.reset}`);
    console.log(`======================================================================`);
    console.log(`    ID: ${colors.dim}${audit.id}${colors.reset} │ Código: ${colors.bold}${audit.code || 'N/A'}${colors.reset} │ Estado: ${audit.isActive ? colors.brightGreen + 'Activo' : colors.dim + 'Inactivo'}${colors.reset}`);
    console.log(`    Banca Actual: ${colors.bold}${audit.bancaName || 'NINGUNA'}${colors.reset} [ID: ${colors.dim}${audit.bancaId || 'N/A'}${colors.reset}]`);
    console.log(`    Ventana/Listero Actual: ${colors.bold}${audit.ventanaName || 'NINGUNA'}${colors.reset} [ID: ${colors.dim}${audit.ventanaId || 'N/A'}${colors.reset}]`);

    const balFormatted = formatCRC(audit.currentBalance);
    const balColor = audit.currentBalance >= 0 ? colors.brightGreen : colors.brightRed;
    console.log(`    Saldo Actual (Banca Actual): ${colors.bold}${balColor}${balFormatted}${colors.reset} ${audit.lastStatementDate ? `(Último Statement: ${audit.lastStatementDate})` : '(Sin registros previos)'}`);

    console.log(`\n📚  ${colors.bold}HISTORIAL EN BANCAS:${colors.reset}`);
    if (audit.bancasHistory.length === 0) {
      console.log(`    ${colors.dim}No tiene historial de AccountStatement registrado en ninguna banca.${colors.reset}`);
    } else {
      audit.bancasHistory.forEach((bh) => {
        const isCurrent = bh.bancaId === audit.bancaId ? ` ${colors.bgYellow}${colors.bold} ACTUAL ${colors.reset}` : '';
        const hBalColor = bh.lastBalance >= 0 ? colors.brightGreen : colors.brightRed;
        console.log(`    • ${colors.bold}${bh.bancaName}${colors.reset}${isCurrent}`);
        console.log(`      Días registrados: ${bh.statementCount} │ Última fecha: ${bh.lastStatementDate || 'N/A'} │ Saldo acumulado: ${colors.bold}${hBalColor}${formatCRC(bh.lastBalance)}${colors.reset}`);
      });
    }

    console.log(`\n----------------------------------------------------------------------`);
    console.log(`Acciones disponibles:`);
    console.log(`  [1] 🔄  Trasladar Vendedor a Otra Banca y Listero/Ventana`);
    console.log(`  [2] 💰  Ajustar Saldo de Partida en una Banca`);
    console.log(`  [B] ⬅️   Volver a la búsqueda de vendedores`);

    const action = await ask(`\nOpción (1-2 o B): `);
    if (isBack(action)) return;

    if (action === '1') {
      await runTransferFlow(audit);
    } else if (action === '2') {
      await runAdjustBalanceFlow(audit);
    } else {
      console.log(`❌  Opción inválida.`);
      await ask(`\nPresione ENTER para continuar...`);
    }
  }
}

async function runTransferFlow(audit: VendorAuditInfo) {
  clearScreen();
  console.log(`======================================================================`);
  console.log(`🔄  ${colors.bold}${colors.brightCyan}TRASLADO DE VENDEDOR: ${audit.name}${colors.reset}`);
  console.log(`======================================================================`);
  console.log(`Banca de Origen: ${colors.bold}${audit.bancaName || 'Ninguna'}${colors.reset} │ Saldo Actual: ${colors.bold}${formatCRC(audit.currentBalance)}${colors.reset}\n`);

  console.log(`⏳  Obteniendo bancas activas...`);
  const bancas = await fetchBancas();
  if (bancas.length === 0) {
    console.log(`❌  No se encontraron bancas activas.`);
    await ask(`\nPresione ENTER para continuar...`);
    return;
  }

  console.log(`\n🏛️  Seleccione la BANCA DESTINO:`);
  bancas.forEach((b, idx) => {
    const isCurrent = b.id === audit.bancaId ? ` ${colors.dim}(Banca actual)${colors.reset}` : '';
    console.log(`  [${idx + 1}] ${b.name}${isCurrent}`);
  });
  console.log(`  [B] ⬅️  Cancelar`);

  const bChoice = await ask(`\nOpción (1-${bancas.length}): `);
  if (isBack(bChoice)) return;
  const bIdx = parseInt(bChoice, 10);
  if (isNaN(bIdx) || bIdx < 1 || bIdx > bancas.length) {
    console.log(`❌  Opción inválida.`);
    await ask(`\nPresione ENTER para continuar...`);
    return;
  }
  const targetBanca = bancas[bIdx - 1];

  console.log(`\n⏳  Obteniendo ventanas/listeros para ${targetBanca.name}...`);
  const ventanas = await fetchVentanas(targetBanca.id);
  if (ventanas.length === 0) {
    console.log(`❌  La banca ${targetBanca.name} no tiene ventanas activas configuradas.`);
    await ask(`\nPresione ENTER para continuar...`);
    return;
  }

  console.log(`\n🏪  Seleccione la VENTANA / LISTERO DESTINO en ${targetBanca.name}:`);
  ventanas.forEach((v, idx) => {
    console.log(`  [${idx + 1}] ${v.name}`);
  });
  console.log(`  [B] ⬅️  Cancelar`);

  const vChoice = await ask(`\nOpción (1-${ventanas.length}): `);
  if (isBack(vChoice)) return;
  const vIdx = parseInt(vChoice, 10);
  if (isNaN(vIdx) || vIdx < 1 || vIdx > ventanas.length) {
    console.log(`❌  Opción inválida.`);
    await ask(`\nPresione ENTER para continuar...`);
    return;
  }
  const targetVentana = ventanas[vIdx - 1];

  console.log(`\n----------------------------------------------------------------------`);
  console.log(`💵  ${colors.bold}GESTIÓN DEL SALDO AL TRASLADAR:${colors.reset}`);
  console.log(`  [1] Iniciar en CERO (0.00) — Borrón y cuenta nueva en la banca destino`);
  console.log(`  [2] Arrastrar saldo actual (${formatCRC(audit.currentBalance)}) a la banca destino`);
  console.log(`  [3] Establecer saldo de partida personalizado`);
  console.log(`  [B] ⬅️  Cancelar`);

  const modeChoice = await ask(`\nSeleccione modo de saldo (1-3): `);
  if (isBack(modeChoice)) return;

  let balanceMode: 'ZERO' | 'CARRY' | 'CUSTOM' = 'ZERO';
  let customBalance = 0;
  let targetInitialBalance = 0;
  let resetOriginBalance = false;

  if (modeChoice === '1') {
    balanceMode = 'ZERO';
    targetInitialBalance = 0;
  } else if (modeChoice === '2') {
    balanceMode = 'CARRY';
    targetInitialBalance = audit.currentBalance;
  } else if (modeChoice === '3') {
    balanceMode = 'CUSTOM';
    const amountStr = await ask(`\nIngrese el saldo de partida deseado (positivo a favor, negativo deuda): `);
    if (isBack(amountStr)) return;
    customBalance = parseFloat(amountStr) || 0;
    targetInitialBalance = customBalance;
  } else {
    console.log(`❌  Opción inválida.`);
    await ask(`\nPresione ENTER para continuar...`);
    return;
  }

  if (audit.bancaId && (balanceMode === 'CARRY' || balanceMode === 'CUSTOM')) {
    const resetPrompt = await ask(`\n⚠️  ¿Desea liquidar/poner en 0 el saldo en la banca de origen (${audit.bancaName}) para no duplicar la deuda? (s/n): `);
    if (resetPrompt.toLowerCase() === 's' || resetPrompt.toLowerCase() === 'si') {
      resetOriginBalance = true;
    }
  }

  const notes = await ask(`\nNotas u observaciones de soporte técnico (opcional) [ENTER para omitir]: `);

  clearScreen();
  console.log(`======================================================================`);
  console.log(`⚠️   ${colors.bold}${colors.brightYellow}CONFIRMACIÓN DE TRASLADO DE VENDEDOR${colors.reset}`);
  console.log(`======================================================================`);
  console.log(`  Vendedor: ${colors.bold}${audit.name}${colors.reset} (@${audit.username || 'N/A'}) [ID: ${colors.dim}${audit.id}${colors.reset}]`);
  console.log(`  Banca Origen: ${colors.bold}${audit.bancaName || 'Ninguna'}${colors.reset} ➔ Banca Destino: ${colors.bold}${colors.brightCyan}${targetBanca.name}${colors.reset}`);
  console.log(`  Ventana Destino: ${colors.bold}${colors.brightCyan}${targetVentana.name}${colors.reset}`);
  console.log(`  Modo de Saldo: ${colors.bold}${balanceMode}${colors.reset} ➔ Saldo Inicial en Destino: ${colors.bold}${formatCRC(targetInitialBalance)}${colors.reset}`);
  if (audit.bancaId) {
    console.log(`  Resetear saldo en origen (${audit.bancaName}): ${resetOriginBalance ? colors.brightYellow + 'SÍ (Quedará en 0)' : colors.dim + 'NO (Mantiene saldo previo)'}${colors.reset}`);
  }
  if (notes) console.log(`  Notas: ${colors.dim}${notes}${colors.reset}`);
  console.log(`----------------------------------------------------------------------`);

  const confirm = await ask(`¿Está completamente seguro de ejecutar este traslado? (si/no): `);
  if (confirm.toLowerCase() !== 'si' && confirm.toLowerCase() !== 's') {
    console.log(`❌  Operación cancelada por el usuario.`);
    await ask(`\nPresione ENTER para continuar...`);
    return;
  }

  console.log(`\n⏳  Ejecutando traslado y sincronización atómica...`);
  try {
    const result = await transferVendorApi({
      vendedorId: audit.id,
      targetBancaId: targetBanca.id,
      targetVentanaId: targetVentana.id,
      balanceMode,
      customBalance,
      resetOriginBalance,
      notes,
    });

    console.log(`\n✅  ${colors.bold}${colors.brightGreen}¡TRASLADO COMPLETADO CON ÉXITO!${colors.reset}`);
    console.log(`    El vendedor ${result.vendorName} ahora pertenece a ${result.targetBanca} (${result.targetVentana}).`);
    console.log(`    Saldo inicial configurado: ${colors.bold}${formatCRC(result.targetInitialBalance)}${colors.reset}`);
    if (result.resetOriginBalance) {
      console.log(`    Saldo en banca previa (${result.originBanca}) liquidado a 0.00.`);
    }
  } catch (err: any) {
    console.log(`\n❌  Error al trasladar vendedor: ${err.message}`);
  }

  await ask(`\nPresione ENTER para volver a la ficha del vendedor...`);
}

async function runAdjustBalanceFlow(audit: VendorAuditInfo) {
  clearScreen();
  console.log(`======================================================================`);
  console.log(`💰  ${colors.bold}${colors.brightCyan}AJUSTE DE SALDO DE PARTIDA: ${audit.name}${colors.reset}`);
  console.log(`======================================================================`);

  console.log(`⏳  Obteniendo bancas activas...`);
  const bancas = await fetchBancas();
  if (bancas.length === 0) {
    console.log(`❌  No se encontraron bancas.`);
    await ask(`\nPresione ENTER para continuar...`);
    return;
  }

  console.log(`\n🏛️  Seleccione la BANCA en la que desea ajustar el saldo:`);
  bancas.forEach((b, idx) => {
    const isCurrent = b.id === audit.bancaId ? ` ${colors.bgYellow}${colors.bold} BANCA ACTUAL ${colors.reset}` : '';
    const hist = audit.bancasHistory.find(h => h.bancaId === b.id);
    const histStr = hist ? ` [Saldo actual: ${formatCRC(hist.lastBalance)}]` : ` [Sin registros]`;
    console.log(`  [${idx + 1}] ${b.name}${isCurrent}${histStr}`);
  });
  console.log(`  [B] ⬅️  Cancelar`);

  const bChoice = await ask(`\nOpción (1-${bancas.length}): `);
  if (isBack(bChoice)) return;
  const bIdx = parseInt(bChoice, 10);
  if (isNaN(bIdx) || bIdx < 1 || bIdx > bancas.length) {
    console.log(`❌  Opción inválida.`);
    await ask(`\nPresione ENTER para continuar...`);
    return;
  }
  const targetBanca = bancas[bIdx - 1];

  const hist = audit.bancasHistory.find(h => h.bancaId === targetBanca.id);
  const currentBalInBanca = hist ? hist.lastBalance : (targetBanca.id === audit.bancaId ? audit.currentBalance : 0);

  console.log(`\nBanca seleccionada: ${colors.bold}${targetBanca.name}${colors.reset}`);
  console.log(`Saldo actual en esta banca: ${colors.bold}${formatCRC(currentBalInBanca)}${colors.reset}`);

  const targetStr = await ask(`\nNuevo saldo de partida para ${audit.name} en ${targetBanca.name}\n(Positivo a favor, negativo deuda): `);
  if (isBack(targetStr)) return;

  const targetBalance = parseFloat(targetStr);
  if (isNaN(targetBalance)) {
    console.log(`❌  Monto inválido.`);
    await ask(`\nPresione ENTER para continuar...`);
    return;
  }

  const reason = await ask(`\nMotivo del ajuste de soporte técnico (ej: Saldo inicial heredado, liquidación previa): `);

  clearScreen();
  console.log(`======================================================================`);
  console.log(`⚠️   ${colors.bold}${colors.brightYellow}CONFIRMACIÓN DE AJUSTE DE SALDO${colors.reset}`);
  console.log(`======================================================================`);
  console.log(`  Vendedor: ${colors.bold}${audit.name}${colors.reset} [ID: ${colors.dim}${audit.id}${colors.reset}]`);
  console.log(`  Banca: ${colors.bold}${targetBanca.name}${colors.reset}`);
  console.log(`  Saldo Anterior: ${colors.bold}${formatCRC(currentBalInBanca)}${colors.reset}`);
  console.log(`  Nuevo Saldo Objetivo: ${colors.bold}${colors.brightCyan}${formatCRC(targetBalance)}${colors.reset}`);
  console.log(`  Motivo: ${colors.dim}${reason || 'Ajuste manual de soporte'}${colors.reset}`);
  console.log(`----------------------------------------------------------------------`);

  const confirm = await ask(`¿Confirma actualizar el saldo de partida? (si/no): `);
  if (confirm.toLowerCase() !== 'si' && confirm.toLowerCase() !== 's') {
    console.log(`❌  Operación cancelada.`);
    await ask(`\nPresione ENTER para continuar...`);
    return;
  }

  console.log(`\n⏳  Aplicando ajuste de saldo e invalidando cachés...`);
  try {
    const result = await adjustVendorBalanceApi({
      vendedorId: audit.id,
      bancaId: targetBanca.id,
      targetBalance,
      reason,
    });

    console.log(`\n✅  ${colors.bold}${colors.brightGreen}¡SALDO AJUSTADO CON ÉXITO!${colors.reset}`);
    console.log(`    Vendedor: ${result.vendorName}`);
    console.log(`    Banca: ${result.bancaName}`);
    console.log(`    Nuevo saldo registrado: ${colors.bold}${formatCRC(result.targetBalance)}${colors.reset}`);
  } catch (err: any) {
    console.log(`\n❌  Error al ajustar saldo: ${err.message}`);
  }

  await ask(`\nPresione ENTER para volver a la ficha del vendedor...`);
}
