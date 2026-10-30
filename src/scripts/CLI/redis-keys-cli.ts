import 'dotenv/config';
import { ask, isBack, colors, clearScreen, IS_RENDER, callOpsApi } from './helpers';
import type { RedisKeyItem, RedisKeyCategory } from '../../domain/cache/redisOps.service';

/**
 * redis-keys-cli.ts
 *
 * MÓDULO INTERACTIVO DE OPERACIONES Y LIMPIEZA DE CLAVES EN REDIS
 *
 * Flujo Principal:
 *   [1] Por BANCA    -> Lista bancas -> Gestión de claves de la Banca
 *   [2] Por LISTERO  -> Lista bancas -> Lista listeros -> Gestión de claves del Listero
 *   [3] Por VENDEDOR -> Lista bancas -> Lista listeros -> Lista vendedores -> Gestión de claves del Vendedor
 *
 * Compatible con:
 * - Entornos locales (llamadas directas vía RedisOpsService)
 * - Render Shell bajo restricción de 100MB RAM (vía endpoints livianos de OpsController)
 */

// ============================================================================
// API / SERVICE FETCHERS
// ============================================================================

async function fetchBancas(): Promise<Array<{ id: string; name: string }>> {
  if (IS_RENDER) {
    const res = await callOpsApi('/vendor/bancas', {});
    return res.bancas || [];
  }
  const { RedisOpsService } = await import('../../domain/cache/redisOps.service');
  return await RedisOpsService.listBancas();
}

async function fetchVentanas(bancaId?: string | null): Promise<Array<{ id: string; name: string; bancaId: string; bancaName: string }>> {
  if (IS_RENDER) {
    const res = await callOpsApi('/redis/ventanas', { bancaId });
    return res.ventanas || [];
  }
  const { RedisOpsService } = await import('../../domain/cache/redisOps.service');
  return await RedisOpsService.listVentanas(bancaId);
}

async function fetchVendorsApi(query?: string, bancaId?: string | null, ventanaId?: string | null): Promise<any[]> {
  if (IS_RENDER) {
    const res = await callOpsApi('/redis/vendors', { query, bancaId, ventanaId });
    return res.vendors || [];
  }
  const { RedisOpsService } = await import('../../domain/cache/redisOps.service');
  return await RedisOpsService.listVendors(query, bancaId, ventanaId);
}

async function fetchBancaKeysApi(bancaId: string): Promise<{
  banca: { id: string; name: string };
  totalKeys: number;
  keys: RedisKeyItem[];
}> {
  if (IS_RENDER) {
    const res = await callOpsApi('/redis/banca/keys', { bancaId });
    return res;
  }
  const { RedisOpsService } = await import('../../domain/cache/redisOps.service');
  return await RedisOpsService.listBancaKeys(bancaId);
}

async function deleteBancaKeysApi(params: { keys?: string[]; bancaId: string; deleteAll?: boolean }): Promise<{
  deletedCount: number;
  deletedKeys: string[];
}> {
  if (IS_RENDER) {
    const res = await callOpsApi('/redis/banca/delete', params);
    return res;
  }
  const { RedisOpsService } = await import('../../domain/cache/redisOps.service');
  if (params.deleteAll) {
    return await RedisOpsService.deleteAllBancaKeys(params.bancaId);
  }
  return await RedisOpsService.deleteKeys(params.keys || [], { bancaId: params.bancaId });
}

async function fetchVentanaKeysApi(ventanaId: string): Promise<{
  ventana: { id: string; name: string; bancaId: string; bancaName: string };
  totalKeys: number;
  keys: RedisKeyItem[];
}> {
  if (IS_RENDER) {
    const res = await callOpsApi('/redis/ventana/keys', { ventanaId });
    return res;
  }
  const { RedisOpsService } = await import('../../domain/cache/redisOps.service');
  return await RedisOpsService.listVentanaKeys(ventanaId);
}

async function deleteVentanaKeysApi(params: { keys?: string[]; ventanaId: string; deleteAll?: boolean }): Promise<{
  deletedCount: number;
  deletedKeys: string[];
}> {
  if (IS_RENDER) {
    const res = await callOpsApi('/redis/ventana/delete', params);
    return res;
  }
  const { RedisOpsService } = await import('../../domain/cache/redisOps.service');
  if (params.deleteAll) {
    return await RedisOpsService.deleteAllVentanaKeys(params.ventanaId);
  }
  return await RedisOpsService.deleteKeys(params.keys || [], { ventanaId: params.ventanaId });
}

async function fetchVendorKeysApi(vendedorId: string): Promise<{
  vendor: { id: string; name: string; username: string; code: string | null; bancaName: string; ventanaName: string };
  totalKeys: number;
  keys: RedisKeyItem[];
}> {
  if (IS_RENDER) {
    const res = await callOpsApi('/redis/vendor/keys', { vendedorId });
    return res;
  }
  const { RedisOpsService } = await import('../../domain/cache/redisOps.service');
  return await RedisOpsService.listVendorKeys(vendedorId);
}

async function deleteVendorKeysApi(params: { keys?: string[]; vendedorId: string; deleteAll?: boolean }): Promise<{
  deletedCount: number;
  deletedKeys: string[];
}> {
  if (IS_RENDER) {
    const res = await callOpsApi('/redis/vendor/delete', params);
    return res;
  }
  const { RedisOpsService } = await import('../../domain/cache/redisOps.service');
  if (params.deleteAll) {
    return await RedisOpsService.deleteAllVendorKeys(params.vendedorId);
  }
  return await RedisOpsService.deleteKeys(params.keys || [], { vendedorId: params.vendedorId });
}

// ============================================================================
// FORMATTERS
// ============================================================================

function formatCategoryBadge(category: RedisKeyCategory): string {
  switch (category) {
    case 'SESION':
      return `${colors.brightCyan}[SESION]${colors.reset}`;
    case 'CREDITO':
      return `${colors.brightYellow}${colors.bold}[CREDITO]${colors.reset}`;
    case 'RESUMEN':
      return `${colors.brightGreen}[RESUMEN]${colors.reset}`;
    case 'COMISION':
      return `${colors.cyan}[COMISION]${colors.reset}`;
    case 'CUTOFF':
      return `${colors.brightMagenta}[CUTOFF]${colors.reset}`;
    case 'RESTRICCION':
      return `${colors.red}[RESTRIC]${colors.reset}`;
    case 'MULTIPLICADOR':
      return `${colors.magenta}[MULTIP]${colors.reset}`;
    case 'ESTADO_CUENTA':
      return `${colors.blue}[EDO_CTA]${colors.reset}`;
    case 'FLAG_SORTEO':
      return `${colors.yellow}[FLAG]${colors.reset}`;
    case 'TAG':
      return `${colors.dim}[TAG]${colors.reset}`;
    default:
      return `${colors.white}[OTRO]${colors.reset}`;
  }
}

function formatTtl(ttl: number): string {
  if (ttl === -1) return `${colors.dim}Sin Exp.${colors.reset}`;
  if (ttl === -2) return `${colors.red}Expirada${colors.reset}`;
  if (ttl < 60) return `${colors.brightYellow}${ttl}s${colors.reset}`;
  if (ttl < 3600) return `${colors.cyan}${Math.round(ttl / 60)}m${colors.reset}`;
  return `${colors.green}${Number((ttl / 3600).toFixed(1))}h${colors.reset}`;
}

// ============================================================================
// MENÚ PRINCIPAL: POR BANCA / POR LISTERO / POR VENDEDOR
// ============================================================================

export async function runRedisKeysWizard() {
  while (true) {
    clearScreen();
    console.log(`======================================================================`);
    console.log(`🧹  ${colors.bold}${colors.brightCyan}GESTIÓN Y LIMPIEZA DE CLAVES EN REDIS${colors.reset}`);
    console.log(`======================================================================`);
    console.log(`💡  ${colors.dim}Escriba "B" en cualquier momento para regresar al menú anterior.${colors.reset}\n`);

    console.log(`¿Cómo desea consultar y gestionar las claves de Redis?\n`);
    console.log(`  [1] 🏛️   ${colors.bold}Por BANCA${colors.reset}`);
    console.log(`           ${colors.dim}Muestra la lista de bancas para gestionar claves globales de la banca${colors.reset}\n`);

    console.log(`  [2] 📋  ${colors.bold}Por LISTERO${colors.reset}`);
    console.log(`           ${colors.dim}Selecciona la banca y luego el listero para ver sus claves y acumulados${colors.reset}\n`);

    console.log(`  [3] 👤  ${colors.bold}Por VENDEDOR${colors.reset}`);
    console.log(`           ${colors.dim}Selecciona banca, listero y vendedor para gestionar saldo, sesión y caché${colors.reset}\n`);

    console.log(`  [B] ⬅️   ${colors.dim}Volver al menú principal de soporte${colors.reset}`);

    const mainChoice = await ask(`\nOpción (1-3 o B): `);
    if (isBack(mainChoice)) return;

    if (mainChoice === '1') {
      await flowPorBanca();
    } else if (mainChoice === '2') {
      await flowPorListero();
    } else if (mainChoice === '3') {
      await flowPorVendedor();
    } else {
      console.log(`❌  Opción no válida.`);
      await ask(`Presione ENTER para continuar...`);
    }
  }
}

// ============================================================================
// 1. FLUJO: POR BANCA
// ============================================================================

async function flowPorBanca() {
  while (true) {
    clearScreen();
    console.log(`======================================================================`);
    console.log(`🏛️   ${colors.bold}CLAVES EN REDIS - POR BANCA${colors.reset}`);
    console.log(`======================================================================`);

    console.log(`⏳  Cargando lista de bancas activas...`);
    let bancas: Array<{ id: string; name: string }> = [];
    try {
      bancas = await fetchBancas();
    } catch (err: any) {
      console.log(`❌  Error al obtener bancas: ${err.message}`);
      await ask(`\nPresione ENTER para volver...`);
      return;
    }

    console.log(`\nSeleccione la Banca a inspeccionar:`);
    bancas.forEach((b, idx) => {
      console.log(`  [${idx + 1}] ${colors.bold}${b.name}${colors.reset} [ID: ${colors.dim}${b.id}${colors.reset}]`);
    });
    console.log(`  [B] ⬅️   Volver`);

    const choice = await ask(`\nOpción (1-${bancas.length} o B): `);
    if (isBack(choice)) return;

    const idx = parseInt(choice, 10);
    if (isNaN(idx) || idx < 1 || idx > bancas.length) {
      console.log(`❌  Opción no válida.`);
      await ask(`Presione ENTER para continuar...`);
      continue;
    }

    const selectedBanca = bancas[idx - 1];

    await keysManagerLoop({
      entityType: 'BANCA',
      id: selectedBanca.id,
      title: `Banca: ${selectedBanca.name}`,
      subtitle: `ID: ${selectedBanca.id}`,
      fetchKeys: async () => {
        const data = await fetchBancaKeysApi(selectedBanca.id);
        return { totalKeys: data.totalKeys, keys: data.keys };
      },
      deleteKeys: async ({ keys, deleteAll }) => {
        return await deleteBancaKeysApi({
          bancaId: selectedBanca.id,
          keys,
          deleteAll,
        });
      },
    });
  }
}

// ============================================================================
// 2. FLUJO: POR LISTERO
// ============================================================================

async function flowPorListero() {
  while (true) {
    clearScreen();
    console.log(`======================================================================`);
    console.log(`📋  ${colors.bold}CLAVES EN REDIS - POR LISTERO${colors.reset}`);
    console.log(`======================================================================`);

    // Paso A: Seleccionar la Banca
    console.log(`⏳  Cargando lista de bancas activas...`);
    let bancas: Array<{ id: string; name: string }> = [];
    try {
      bancas = await fetchBancas();
    } catch (err: any) {
      console.log(`❌  Error al obtener bancas: ${err.message}`);
      await ask(`\nPresione ENTER para volver...`);
      return;
    }

    console.log(`\n🏛️   ${colors.bold}PASO 1: SELECCIONE LA BANCA DEL LISTERO:${colors.reset}`);
    bancas.forEach((b, idx) => {
      console.log(`  [${idx + 1}] ${colors.bold}${b.name}${colors.reset}`);
    });
    console.log(`  [0] 🌐  ${colors.brightYellow}Todas las Bancas (Búsqueda global)${colors.reset}`);
    console.log(`  [B] ⬅️   Volver`);

    const bancaChoice = await ask(`\nOpción (0-${bancas.length} o B): `);
    if (isBack(bancaChoice)) return;

    let targetBancaId: string | null = null;
    let targetBancaName = 'TODAS LAS BANCAS';

    if (bancaChoice !== '0') {
      const idx = parseInt(bancaChoice, 10);
      if (isNaN(idx) || idx < 1 || idx > bancas.length) {
        console.log(`❌  Opción no válida.`);
        await ask(`Presione ENTER para continuar...`);
        continue;
      }
      targetBancaId = bancas[idx - 1].id;
      targetBancaName = bancas[idx - 1].name;
    }

    // Paso B: Seleccionar el Listero de esa Banca
    await selectListeroAndManage(targetBancaId, targetBancaName);
  }
}

async function selectListeroAndManage(bancaId: string | null, bancaName: string) {
  let searchFilter = '';

  while (true) {
    clearScreen();
    console.log(`======================================================================`);
    console.log(`📋  ${colors.bold}PASO 2: SELECCIONE EL LISTERO${colors.reset}`);
    console.log(`🏛️   Banca: ${colors.bold}${colors.brightCyan}${bancaName}${colors.reset}`);
    if (searchFilter) {
      console.log(`🔍  Filtro activo: "${colors.brightYellow}${searchFilter}${colors.reset}"`);
    }
    console.log(`======================================================================`);

    console.log(`⏳  Cargando listeros...`);
    let listeros: any[] = [];
    try {
      listeros = await fetchVentanas(bancaId);
    } catch (err: any) {
      console.log(`❌  Error al obtener listeros: ${err.message}`);
      await ask(`\nPresione ENTER para volver...`);
      return;
    }

    if (searchFilter) {
      const q = searchFilter.toLowerCase();
      listeros = listeros.filter((l) => l.name.toLowerCase().includes(q) || (l.bancaName && l.bancaName.toLowerCase().includes(q)));
    }

    if (listeros.length === 0) {
      console.log(`\n⚠️   ${colors.yellow}No se encontraron listeros${searchFilter ? ` con el filtro "${searchFilter}"` : ''} en ${bancaName}.${colors.reset}`);
      console.log(`  [F] 🔍  Cambiar filtro de búsqueda`);
      console.log(`  [B] ⬅️   Volver a selección de banca`);
      const emptyOpt = await ask(`\nOpción: `);
      if (isBack(emptyOpt)) return;
      if (emptyOpt.toLowerCase() === 'f') {
        searchFilter = await ask(`Ingrese texto para filtrar listeros: `);
      }
      continue;
    }

    console.log(`\n${colors.bold}Listeros disponibles (${listeros.length}):${colors.reset}`);
    listeros.forEach((l, idx) => {
      const bancaStr = !bancaId ? `[Banca: ${l.bancaName}]` : '';
      console.log(`  [${idx + 1}] ${colors.bold}${l.name}${colors.reset} ${colors.dim}${bancaStr} (ID: ${l.id})${colors.reset}`);
    });

    console.log(`\nAcciones:`);
    console.log(`  [1-${listeros.length}] 👉  Seleccionar listero`);
    console.log(`  [F] 🔍  Filtrar por texto`);
    if (searchFilter) {
      console.log(`  [X] 🧹  Limpiar filtro de búsqueda`);
    }
    console.log(`  [B] ⬅️   Volver`);

    const choice = await ask(`\nOpción: `);
    if (isBack(choice)) return;

    if (choice.toLowerCase() === 'f') {
      searchFilter = await ask(`Ingrese texto para filtrar: `);
      continue;
    }

    if (choice.toLowerCase() === 'x') {
      searchFilter = '';
      continue;
    }

    const idx = parseInt(choice, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= listeros.length) {
      const selectedListero = listeros[idx - 1];
      await keysManagerLoop({
        entityType: 'LISTERO',
        id: selectedListero.id,
        title: `Listero: ${selectedListero.name}`,
        subtitle: `Banca: ${selectedListero.bancaName} | ID: ${selectedListero.id}`,
        fetchKeys: async () => {
          const data = await fetchVentanaKeysApi(selectedListero.id);
          return { totalKeys: data.totalKeys, keys: data.keys };
        },
        deleteKeys: async ({ keys, deleteAll }) => {
          return await deleteVentanaKeysApi({
            ventanaId: selectedListero.id,
            keys,
            deleteAll,
          });
        },
      });
    } else {
      console.log(`❌  Opción no válida.`);
      await ask(`Presione ENTER para continuar...`);
    }
  }
}

// ============================================================================
// 3. FLUJO: POR VENDEDOR
// ============================================================================

async function flowPorVendedor() {
  while (true) {
    clearScreen();
    console.log(`======================================================================`);
    console.log(`👤  ${colors.bold}CLAVES EN REDIS - POR VENDEDOR${colors.reset}`);
    console.log(`======================================================================`);

    // Paso A: Seleccionar Banca
    console.log(`⏳  Cargando lista de bancas activas...`);
    let bancas: Array<{ id: string; name: string }> = [];
    try {
      bancas = await fetchBancas();
    } catch (err: any) {
      console.log(`❌  Error al obtener bancas: ${err.message}`);
      await ask(`\nPresione ENTER para volver...`);
      return;
    }

    console.log(`\n🏛️   ${colors.bold}PASO 1: SELECCIONE LA BANCA:${colors.reset}`);
    bancas.forEach((b, idx) => {
      console.log(`  [${idx + 1}] ${colors.bold}${b.name}${colors.reset}`);
    });
    console.log(`  [0] 🌐  ${colors.brightYellow}Todas las Bancas (Búsqueda global)${colors.reset}`);
    console.log(`  [B] ⬅️   Volver`);

    const bancaChoice = await ask(`\nOpción (0-${bancas.length} o B): `);
    if (isBack(bancaChoice)) return;

    let targetBancaId: string | null = null;
    let targetBancaName = 'TODAS LAS BANCAS';

    if (bancaChoice !== '0') {
      const idx = parseInt(bancaChoice, 10);
      if (isNaN(idx) || idx < 1 || idx > bancas.length) {
        console.log(`❌  Opción no válida.`);
        await ask(`Presione ENTER para continuar...`);
        continue;
      }
      targetBancaId = bancas[idx - 1].id;
      targetBancaName = bancas[idx - 1].name;
    }

    // Paso B: Seleccionar Listero de la Banca
    await selectListeroForVendorFlow(targetBancaId, targetBancaName);
  }
}

async function selectListeroForVendorFlow(bancaId: string | null, bancaName: string) {
  while (true) {
    clearScreen();
    console.log(`======================================================================`);
    console.log(`📋  ${colors.bold}PASO 2: SELECCIONE EL LISTERO${colors.reset}`);
    console.log(`🏛️   Banca: ${colors.bold}${colors.brightCyan}${bancaName}${colors.reset}`);
    console.log(`======================================================================`);

    console.log(`⏳  Cargando listeros...`);
    let listeros: any[] = [];
    try {
      listeros = await fetchVentanas(bancaId);
    } catch (err: any) {
      console.log(`❌  Error al obtener listeros: ${err.message}`);
      await ask(`\nPresione ENTER para volver...`);
      return;
    }

    console.log(`\nSeleccione el Listero para ver sus vendedores:`);
    listeros.forEach((l, idx) => {
      const bancaStr = !bancaId ? `[Banca: ${l.bancaName}]` : '';
      console.log(`  [${idx + 1}] ${colors.bold}${l.name}${colors.reset} ${colors.dim}${bancaStr}${colors.reset}`);
    });
    console.log(`  [0] 👥  ${colors.brightYellow}Todos los Listeros de esta banca (Ver todos los vendedores)${colors.reset}`);
    console.log(`  [B] ⬅️   Volver a selección de banca`);

    const choice = await ask(`\nOpción (0-${listeros.length} o B): `);
    if (isBack(choice)) return;

    let targetVentanaId: string | null = null;
    let targetVentanaName: string | null = null;

    if (choice !== '0') {
      const idx = parseInt(choice, 10);
      if (isNaN(idx) || idx < 1 || idx > listeros.length) {
        console.log(`❌  Opción no válida.`);
        await ask(`Presione ENTER para continuar...`);
        continue;
      }
      targetVentanaId = listeros[idx - 1].id;
      targetVentanaName = listeros[idx - 1].name;
    }

    // Paso C: Seleccionar Vendedor
    await selectVendorAndManage(bancaId, bancaName, targetVentanaId, targetVentanaName);
  }
}

async function selectVendorAndManage(
  bancaId: string | null,
  bancaName: string,
  ventanaId: string | null,
  ventanaName: string | null
) {
  let searchFilter = '';

  while (true) {
    clearScreen();
    console.log(`======================================================================`);
    console.log(`👤  ${colors.bold}PASO 3: SELECCIONE EL VENDEDOR${colors.reset}`);
    console.log(`🏛️   Banca: ${colors.bold}${colors.brightCyan}${bancaName}${colors.reset}`);
    if (ventanaName) {
      console.log(`📋  Listero: ${colors.bold}${colors.brightGreen}${ventanaName}${colors.reset}`);
    }
    if (searchFilter) {
      console.log(`🔍  Filtro activo: "${colors.brightYellow}${searchFilter}${colors.reset}"`);
    }
    console.log(`======================================================================`);

    console.log(`⏳  Buscando vendedores...`);
    let vendors: any[] = [];
    try {
      vendors = await fetchVendorsApi(searchFilter, bancaId, ventanaId);
    } catch (err: any) {
      console.log(`❌  Error al buscar vendedores: ${err.message}`);
      await ask(`\nPresione ENTER para volver...`);
      return;
    }

    if (vendors.length === 0) {
      console.log(`\n⚠️   ${colors.yellow}No se encontraron vendedores${searchFilter ? ` con el filtro "${searchFilter}"` : ''}.${colors.reset}`);
      console.log(`  [F] 🔍  Cambiar filtro de búsqueda`);
      console.log(`  [B] ⬅️   Volver a selección de listero`);
      const opt = await ask(`\nOpción: `);
      if (isBack(opt)) return;
      if (opt.toLowerCase() === 'f') {
        searchFilter = await ask(`Ingrese texto para filtrar (nombre, usuario o código): `);
      }
      continue;
    }

    console.log(`\n${colors.bold}Vendedores encontrados (${vendors.length}):${colors.reset}`);
    vendors.forEach((v, idx) => {
      const codeStr = v.code ? `[Cód: ${v.code}]` : '';
      const listeroStr = v.ventanaName ? `| Listero: ${v.ventanaName}` : '';
      const bancaStr = !bancaId ? `| Banca: ${v.bancaName}` : '';
      console.log(`  [${idx + 1}] ${colors.bold}${v.name}${colors.reset} (@${colors.brightCyan}${v.username}${colors.reset}) ${colors.dim}${codeStr} ${listeroStr} ${bancaStr}${colors.reset}`);
    });

    console.log(`\nAcciones:`);
    console.log(`  [1-${vendors.length}] 👉  Seleccionar vendedor`);
    console.log(`  [F] 🔍  Filtrar por texto (nombre, usuario o código)`);
    if (searchFilter) {
      console.log(`  [X] 🧹  Limpiar filtro de búsqueda`);
    }
    console.log(`  [B] ⬅️   Volver a selección de listero`);

    const choice = await ask(`\nOpción: `);
    if (isBack(choice)) return;

    if (choice.toLowerCase() === 'f') {
      searchFilter = await ask(`Ingrese texto para filtrar: `);
      continue;
    }

    if (choice.toLowerCase() === 'x') {
      searchFilter = '';
      continue;
    }

    const idx = parseInt(choice, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= vendors.length) {
      const selectedVendor = vendors[idx - 1];
      await keysManagerLoop({
        entityType: 'VENDEDOR',
        id: selectedVendor.id,
        title: `Vendedor: ${selectedVendor.name} (@${selectedVendor.username})`,
        subtitle: `Banca: ${selectedVendor.bancaName} | Listero: ${selectedVendor.ventanaName} | ID: ${selectedVendor.id}`,
        fetchKeys: async () => {
          const data = await fetchVendorKeysApi(selectedVendor.id);
          return { totalKeys: data.totalKeys, keys: data.keys };
        },
        deleteKeys: async ({ keys, deleteAll }) => {
          return await deleteVendorKeysApi({
            vendedorId: selectedVendor.id,
            keys,
            deleteAll,
          });
        },
      });
    } else {
      console.log(`❌  Opción no válida.`);
      await ask(`Presione ENTER para continuar...`);
    }
  }
}

// ============================================================================
// GESTOR REUTILIZABLE DE CLAVES (TABLA, CATEGORÍAS, BORRADO INDIVIDUAL Y TOTAL)
// ============================================================================

interface KeysManagerContext {
  entityType: 'BANCA' | 'LISTERO' | 'VENDEDOR';
  id: string;
  title: string;
  subtitle: string;
  fetchKeys: () => Promise<{ totalKeys: number; keys: RedisKeyItem[] }>;
  deleteKeys: (params: { keys?: string[]; deleteAll?: boolean }) => Promise<{ deletedCount: number; deletedKeys: string[] }>;
}

async function keysManagerLoop(ctx: KeysManagerContext) {
  let categoryFilter: RedisKeyCategory | 'ALL' = 'ALL';

  while (true) {
    clearScreen();
    console.log(`======================================================================`);
    console.log(`🔑  ${colors.bold}GESTIÓN DE CLAVES EN REDIS - NIVEL ${ctx.entityType}${colors.reset}`);
    console.log(`📌  ${colors.bold}${colors.brightCyan}${ctx.title}${colors.reset}`);
    console.log(`🏛️   ${colors.dim}${ctx.subtitle}${colors.reset}`);
    if (categoryFilter !== 'ALL') {
      console.log(`🏷️   Filtro por Categoría: ${colors.brightYellow}${categoryFilter}${colors.reset}`);
    }
    console.log(`======================================================================`);

    console.log(`⏳  Escaneando Redis para este ${ctx.entityType.toLowerCase()}...`);
    let data: { totalKeys: number; keys: RedisKeyItem[] };
    try {
      data = await ctx.fetchKeys();
    } catch (err: any) {
      console.log(`❌  Error al obtener claves de Redis: ${err.message}`);
      await ask(`\nPresione ENTER para volver...`);
      return;
    }

    let displayedKeys = data.keys;
    if (categoryFilter !== 'ALL') {
      displayedKeys = displayedKeys.filter((k) => k.category === categoryFilter);
    }

    console.log(`\n📊  Total de claves encontradas: ${colors.bold}${colors.brightGreen}${data.totalKeys}${colors.reset} (Mostrando: ${displayedKeys.length})\n`);

    if (displayedKeys.length === 0) {
      console.log(`ℹ️   ${colors.yellow}No hay claves activas en Redis para los criterios seleccionados.${colors.reset}\n`);
      console.log(`Acciones:`);
      if (categoryFilter !== 'ALL') {
        console.log(`  [X] 🧹  Mostrar todas las categorías`);
      }
      console.log(`  [R] 🔄  Re-escanear Redis`);
      console.log(`  [B] ⬅️   Volver`);

      const emptyChoice = await ask(`\nOpción: `);
      if (isBack(emptyChoice)) return;
      if (emptyChoice.toLowerCase() === 'x') {
        categoryFilter = 'ALL';
      }
      continue;
    }

    // Tabla de claves
    console.log(`${colors.dim}N°   CATEGORIA       TTL       TIPO     CLAVE / DESCRIPCION${colors.reset}`);
    console.log(`${colors.dim}----------------------------------------------------------------------${colors.reset}`);

    displayedKeys.forEach((item, idx) => {
      const numStr = (idx + 1).toString().padStart(3, ' ');
      const catBadge = formatCategoryBadge(item.category).padEnd(16, ' ');
      const ttlStr = formatTtl(item.ttl).padEnd(17, ' ');
      const typeStr = item.type.padEnd(8, ' ');
      console.log(`[${numStr}] ${catBadge} ${ttlStr} ${colors.dim}${typeStr}${colors.reset} ${colors.bold}${item.key}${colors.reset}`);
      console.log(`      └─ ${colors.dim}${item.description}${colors.reset}`);
    });

    console.log(`\n======================================================================`);
    console.log(`⚙️   ${colors.bold}ACCIONES DISPONIBLES:${colors.reset}`);
    console.log(`  [1-${displayedKeys.length}] 🗑️   ${colors.brightRed}Eliminar una clave específica${colors.reset}`);
    console.log(`  [A] 💣  ${colors.bgRed}${colors.bold} ELIMINAR TODAS LAS CLAVES (${displayedKeys.length}) ${colors.reset}`);
    console.log(`  [C] 🏷️   Filtrar por categoría (Sesión, Crédito, Resumen, etc.)`);
    if (categoryFilter !== 'ALL') {
      console.log(`  [X] 🧹  Quitar filtro de categoría (Ver todas)`);
    }
    console.log(`  [R] 🔄  Re-escanear Redis`);
    console.log(`  [B] ⬅️   Volver`);

    const action = await ask(`\nOpción: `);
    if (isBack(action)) return;

    if (action.toLowerCase() === 'r') {
      continue;
    }

    if (action.toLowerCase() === 'x') {
      categoryFilter = 'ALL';
      continue;
    }

    if (action.toLowerCase() === 'c') {
      const categories: RedisKeyCategory[] = [
        'SESION',
        'CREDITO',
        'RESUMEN',
        'COMISION',
        'CUTOFF',
        'RESTRICCION',
        'MULTIPLICADOR',
        'ESTADO_CUENTA',
        'FLAG_SORTEO',
        'TAG',
        'OTRO',
      ];
      console.log(`\n🏷️   Seleccione la categoría para filtrar:`);
      categories.forEach((cat, cIdx) => {
        const count = data.keys.filter((k) => k.category === cat).length;
        console.log(`  [${cIdx + 1}] ${formatCategoryBadge(cat)} (${count} claves)`);
      });
      console.log(`  [0] Todas las categorías`);
      console.log(`  [B] Cancelar`);

      const catChoice = await ask(`\nOpción (0-${categories.length} o B): `);
      if (isBack(catChoice)) continue;
      if (catChoice === '0') {
        categoryFilter = 'ALL';
      } else {
        const cIdx = parseInt(catChoice, 10);
        if (!isNaN(cIdx) && cIdx >= 1 && cIdx <= categories.length) {
          categoryFilter = categories[cIdx - 1];
        }
      }
      continue;
    }

    if (action.toUpperCase() === 'A') {
      const keysToDelete = displayedKeys.map((k) => k.key);
      console.log(`\n⚠️   ${colors.bgRed}${colors.bold} ADVERTENCIA DE ELIMINACIÓN MASIVA ${colors.reset}`);
      console.log(`Se eliminarán ${colors.bold}${colors.brightRed}${keysToDelete.length} claves${colors.reset} de Redis para ${colors.bold}${ctx.title}${colors.reset}.`);
      console.log(`Esto invalidará los cachés de nivel ${ctx.entityType} en Redis y RAM local, recargando datos frescos de PostgreSQL.`);

      const confirm = await ask(`\n¿Está absolutamente seguro de proceder? Escriba "${colors.bold}ELIMINAR${colors.reset}" para confirmar: `);
      if (confirm !== 'ELIMINAR') {
        console.log(`❌  Operación cancelada.`);
        await ask(`Presione ENTER para continuar...`);
        continue;
      }

      console.log(`\n⏳  Eliminando ${keysToDelete.length} claves en Redis...`);
      try {
        const isPurgeAll = categoryFilter === 'ALL' && displayedKeys.length === data.totalKeys;
        const res = await ctx.deleteKeys({
          keys: isPurgeAll ? undefined : keysToDelete,
          deleteAll: isPurgeAll,
        });
        console.log(`\n✅  ${colors.brightGreen}${colors.bold}ÉXITO:${colors.reset} Se eliminaron ${res.deletedCount} claves de Redis.`);
      } catch (err: any) {
        console.log(`\n❌  Error al eliminar claves: ${err.message}`);
      }
      await ask(`\nPresione ENTER para continuar...`);
      continue;
    }

    // Selección individual de clave
    const itemIdx = parseInt(action, 10);
    if (!isNaN(itemIdx) && itemIdx >= 1 && itemIdx <= displayedKeys.length) {
      const targetItem = displayedKeys[itemIdx - 1];
      console.log(`\n🔑  ${colors.bold}Clave seleccionada:${colors.reset}`);
      console.log(`    Nombre:      ${colors.brightCyan}${targetItem.key}${colors.reset}`);
      console.log(`    Categoría:   ${targetItem.category}`);
      console.log(`    Descripción: ${targetItem.description}`);
      console.log(`    TTL actual:  ${formatTtl(targetItem.ttl)}`);

      const confirm = await ask(`\n¿Confirma la eliminación de esta clave en Redis? (si/no): `);
      if (confirm.toLowerCase() === 'si' || confirm.toLowerCase() === 's') {
        console.log(`\n⏳  Eliminando clave "${targetItem.key}"...`);
        try {
          const res = await ctx.deleteKeys({
            keys: [targetItem.key],
          });
          console.log(`✅  ${colors.brightGreen}Clave eliminada con éxito.${colors.reset} (Unlinked: ${res.deletedCount})`);
        } catch (err: any) {
          console.log(`❌  Error al eliminar clave: ${err.message}`);
        }
      } else {
        console.log(`❌  Operación cancelada.`);
      }
      await ask(`\nPresione ENTER para continuar...`);
      continue;
    }

    console.log(`❌  Opción no válida.`);
    await ask(`Presione ENTER para continuar...`);
  }
}
