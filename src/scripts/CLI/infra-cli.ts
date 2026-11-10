import 'dotenv/config';
import { ask, isBack, colors, clearScreen } from './helpers';
import { runRedisKeysWizard } from './redis-keys-cli';
import { runMonitorEvaluation } from './monitor-evaluation-cli';

/**
 * infra-cli.ts
 *
 * MÓDULO CLI PARA INFRAESTRUCTURA, CACHÉ Y TELEMETRÍA
 *
 * Opciones:
 * 1. Gestión y Limpieza de Claves en Redis (Por Banca, Ventana, Vendedor)
 * 2. Monitoreo en Tiempo Real de Sorteos y Terminales (Better Stack Logs)
 */

export async function runInfraWizard() {
  while (true) {
    clearScreen();
    console.log(`======================================================================`);
    console.log(`⚡  ${colors.bold}${colors.brightCyan}INFRAESTRUCTURA, CACHÉ Y TELEMETRÍA${colors.reset}`);
    console.log(`======================================================================`);
    console.log(`Seleccione una opción:`);
    console.log(`  [1] 🧹  Gestión y Limpieza de Claves en Redis (Por Banca y Vendedor)`);
    console.log(`  [2] 📡  Monitoreo en Tiempo Real de Sorteos y Terminales (Better Stack)`);
    console.log(`  [B] ⬅️   Volver al Menú Principal`);

    const choice = await ask(`\nOpción (1-2 o B para volver): `);

    if (isBack(choice)) {
      break;
    }

    if (choice === '1') {
      await runRedisKeysWizard();
    } else if (choice === '2') {
      const minInput = await ask(`\n⏱️  Ventana en minutos a consultar [ENTER para 15 minutos, B para volver]: `);
      if (isBack(minInput)) continue;
      const minutes = parseInt(minInput, 10) || 15;
      await runMonitorEvaluation(minutes);
      await ask(`\nPresione ENTER para continuar...`);
    } else {
      console.log(`❌  Opción no válida.`);
      await ask(`\nPresione ENTER para continuar...`);
    }
  }
}
