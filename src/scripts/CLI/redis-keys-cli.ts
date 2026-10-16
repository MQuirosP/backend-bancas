import 'dotenv/config';
import { ask, isBack, colors, clearScreen, IS_RENDER, callOpsApi } from './helpers';
import { RedisOpsService, RedisKeyItem, RedisKeyCategory } from '../../domain/cache/redisOps.service';

/**
 * redis-keys-cli.ts
 *
 * MÓDULO INTERACTIVO DE OPERACIONES Y LIMPIEZA DE CLAVES EN REDIS
 * Flujo:
 * 1. Selección de Banca (o Global).
 * 2. Selección de Vendedor perteneciente a la Banca.
 * 3. Inspección, filtrado y eliminación segura de claves (individual o total).
 *
 * Compatible con:
 * - Entornos locales (llamadas directas vía RedisOpsService)
 * - Render Shell bajo restricción de 100MB RAM (vía endpoints livianos de OpsController)
 */

async function fetchBancas(): Promise<Array<{ id: string; name: string }>> {
  if (IS_RENDER) {
    const res = await callOpsApi('/vendor/bancas', {});
    return res.bancas || [];
  }
  return await RedisOpsService.listBancas();
}

async function fetchVendorsApi(query?: string, bancaId?: string | null): Promise<any[]> {
  if (IS_RENDER) {
    const res = await callOpsApi('/redis/vendors', { query, bancaId });
    return res.vendors || [];
  }
  return await RedisOpsService.listVendors(query, bancaId);
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
  if (params.deleteAll) {
    return await RedisOpsService.deleteAllVendorKeys(params.vendedorId);
  }
  return await RedisOpsService.deleteKeys(params.keys || [], params.vendedorId);
}

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

export async function runRedisKeysWizard() {
  while (true) {
    clearScreen();
    console.log(`======================================================================`);
    console.log(`🧹  ${colors.bold}${colors.brightCyan}GESTIÓN Y LIMPIEZA DE CLAVES EN REDIS${colors.reset}`);
    console.log(`======================================================================`);
    console.log(`💡  ${colors.dim}Escriba "B" en cualquier momento para regresar al menú principal.${colors.reset}\n`);

    // PASO 1: Seleccionar Banca
    console.log(`⏳  Cargando lista de bancas activas...`);
    let bancas: Array<{ id: string; name: string }> = [];
    try {
      bancas = await fetchBancas();
    } catch (err: any) {
      console.log(`❌  Error al obtener bancas: ${err.message}`);
      await ask(`\nPresione ENTER para reintentar...`);
      continue;
    }

    console.log(`\n🏛️   ${colors.bold}PASO 1: SELECCIONE LA BANCA:${colors.reset}`);
    bancas.forEach((b, idx) => {
      console.log(`  [${idx + 1}] ${colors.bold}${b.name}${colors.reset} [ID: ${colors.dim}${b.id}${colors.reset}]`);
    });
    console.log(`  [0] 🌐  ${colors.brightYellow}Todas las Bancas / Búsqueda Global${colors.reset}`);
    console.log(`  [B] ⬅️   Volver al menú principal`);

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

    // PASO 2: Seleccionar Vendedor dentro de la Banca
    await vendorSelectionLoop(targetBancaId, targetBancaName);
  }
}

async function vendorSelectionLoop(bancaId: string | null, bancaName: string) {
  let searchFilter = '';

  while (true) {
    clearScreen();
    console.log(`======================================================================`);
    console.log(`👤  ${colors.bold}PASO 2: SELECCIONE EL VENDEDOR${colors.reset}`);
    console.log(`🏛️   Banca: ${colors.bold}${colors.brightCyan}${bancaName}${colors.reset}`);
    if (searchFilter) {
      console.log(`🔍  Filtro activo: "${colors.brightYellow}${searchFilter}${colors.reset}"`);
    }
    console.log(`======================================================================`);

    console.log(`⏳  Buscando vendedores (Role: VENDEDOR)...`);
    let vendors: any[] = [];
    try {
      vendors = await fetchVendorsApi(searchFilter, bancaId);
    } catch (err: any) {
      console.log(`❌  Error al buscar vendedores: ${err.message}`);
      await ask(`\nPresione ENTER para volver...`);
      return;
    }

    if (vendors.length === 0) {
      console.log(`\n⚠️   ${colors.yellow}No se encontraron vendedores${searchFilter ? ` con el filtro "${searchFilter}"` : ''} en esta banca.${colors.reset}`);
      console.log(`  [F] 🔍  Cambiar filtro de búsqueda`);
      console.log(`  [B] ⬅️   Volver a selección de banca`);
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
      const ventanaStr = v.ventanaName ? `| Ventana: ${v.ventanaName}` : '';
      const bancaStr = !bancaId ? `| Banca: ${v.bancaName}` : '';
      console.log(`  [${idx + 1}] ${colors.bold}${v.name}${colors.reset} (@${colors.brightCyan}${v.username}${colors.reset}) ${colors.dim}${codeStr} ${ventanaStr} ${bancaStr}${colors.reset}`);
    });

    console.log(`\nAcciones:`);
    console.log(`  [1-${vendors.length}] 👉  Seleccionar vendedor`);
    console.log(`  [F] 🔍  Filtrar por texto (nombre, usuario o código)`);
    if (searchFilter) {
      console.log(`  [X] 🧹  Limpiar filtro de búsqueda`);
    }
    console.log(`  [B] ⬅️   Volver a selección de banca`);

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
      await vendorKeysLoop(selectedVendor);
    } else {
      console.log(`❌  Opción no válida.`);
      await ask(`Presione ENTER para continuar...`);
    }
  }
}

async function vendorKeysLoop(vendorSummary: any) {
  let categoryFilter: RedisKeyCategory | 'ALL' = 'ALL';

  while (true) {
    clearScreen();
    console.log(`======================================================================`);
    console.log(`🔑  ${colors.bold}PASO 3: CLAVES DE REDIS DEL VENDEDOR${colors.reset}`);
    console.log(`👤  Vendedor: ${colors.bold}${colors.brightCyan}${vendorSummary.name}${colors.reset} (@${vendorSummary.username})`);
    console.log(`🏛️   Banca: ${vendorSummary.bancaName} | Ventana: ${vendorSummary.ventanaName} | ID: ${colors.dim}${vendorSummary.id}${colors.reset}`);
    if (categoryFilter !== 'ALL') {
      console.log(`🏷️   Filtro por Categoría: ${colors.brightYellow}${categoryFilter}${colors.reset}`);
    }
    console.log(`======================================================================`);

    console.log(`⏳  Escaneando Redis para este vendedor...`);
    let data: { vendor: any; totalKeys: number; keys: RedisKeyItem[] };
    try {
      data = await fetchVendorKeysApi(vendorSummary.id);
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
      console.log(`  [B] ⬅️   Volver a selección de vendedores`);

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
    console.log(`  [B] ⬅️   Volver a selección de vendedores`);

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
      // Menú de selección de categorías
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
      // Eliminar todas las claves mostradas
      const keysToDelete = displayedKeys.map((k) => k.key);
      console.log(`\n⚠️   ${colors.bgRed}${colors.bold} ADVERTENCIA DE ELIMINACIÓN MASIVA ${colors.reset}`);
      console.log(`Se eliminarán ${colors.bold}${colors.brightRed}${keysToDelete.length} claves${colors.reset} de Redis para ${colors.bold}${vendorSummary.name}${colors.reset}.`);
      console.log(`Esto cerrará sesiones activas, invalidará cachés de crédito y recargará datos desde PostgreSQL en la próxima solicitud.`);

      const confirm = await ask(`\n¿Está absolutamente seguro de proceder? Escriba "${colors.bold}ELIMINAR${colors.reset}" para confirmar: `);
      if (confirm !== 'ELIMINAR') {
        console.log(`❌  Operación cancelada.`);
        await ask(`Presione ENTER para continuar...`);
        continue;
      }

      console.log(`\n⏳  Eliminando ${keysToDelete.length} claves en Redis...`);
      try {
        const isPurgeAll = categoryFilter === 'ALL' && displayedKeys.length === data.totalKeys;
        const res = await deleteVendorKeysApi({
          vendedorId: vendorSummary.id,
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
          const res = await deleteVendorKeysApi({
            vendedorId: vendorSummary.id,
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
