import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Prioridad: .env.local (desarrollo local), luego .env
const envLocalPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envLocalPath)) {
  dotenv.config({ path: envLocalPath });
}
dotenv.config();

import { ask, isBack, rl, clearScreen, IS_RENDER } from './helpers';
import { runSorteosWizard } from './sorteos-cli';
import { runTicketsWizard } from './tickets-cli';
import { runCommissionsWizard } from './commissions-cli';
import { runAccountingWizard } from './accounting-cli';
import { runVendorOpsWizard } from './vendor-ops-cli';
import { runInfraWizard } from './infra-cli';

/**
 * main-wizard.ts
 *
 * ORQUESTADOR PRINCIPAL DE LA SUITE CLI DE SOPORTE TÉCNICO Y OPERACIONES (RENDER / CLI)
 * Punto de entrada único centralizado para todas las tareas de mantenimiento y soporte.
 *
 * USO:
 *   npm run ops        (Producción / Render Shell)
 *   npm run ops:dev    (Desarrollo Local con recarga TypeScript)
 */

async function main() {
  while (true) {
    clearScreen();
    console.log(`======================================================================`);
    console.log(`🛠️   SUITE DE SOPORTE TÉCNICO Y OPERACIONES (RENDER & LOCAL CLI)`);
    console.log(`======================================================================`);
    console.log(`Seleccione el módulo de trabajo:\n`);
    console.log(`  [1] 🎰  Sorteos y Loterías`);
    console.log(`  [2] 🎟️   Tickets y Ventas`);
    console.log(`  [3] 💰  Políticas y Comisiones`);
    console.log(`  [4] 📊  Contabilidad, Cierres y Balances`);
    console.log(`  [5] 👥  Vendedores y Red de Ventas`);
    console.log(`  [6] ⚡  Infraestructura, Caché y Telemetría`);
    console.log(`  [0] 🚪  Salir`);

    const optionChoice = await ask(`\nOpción (0-6): `);

    if (optionChoice === '0' || isBack(optionChoice)) {
      console.log(`\n👋  Saliendo de la Suite de Soporte.`);
      break;
    }

    if (optionChoice === '1') {
      await runSorteosWizard();
    } else if (optionChoice === '2') {
      await runTicketsWizard();
    } else if (optionChoice === '3') {
      await runCommissionsWizard();
    } else if (optionChoice === '4') {
      await runAccountingWizard();
    } else if (optionChoice === '5') {
      await runVendorOpsWizard();
    } else if (optionChoice === '6') {
      await runInfraWizard();
    } else {
      console.log(`❌  Opción no válida.`);
      await ask(`\nPresione ENTER para continuar...`);
    }
  }

  rl.close();
  if (!IS_RENDER) {
    try {
      const { default: prisma } = await import('../../core/prismaClient');
      await prisma.$disconnect();
    } catch (e) {}
  }
  process.exit(0);
}

main().catch(async (err) => {
  console.error(`\n❌  ERROR FATAL: ${err.message}`);
  rl.close();
  if (!IS_RENDER) {
    try {
      const { default: prisma } = await import('../../core/prismaClient');
      await prisma.$disconnect();
    } catch (e) {}
  }
  process.exit(1);
});
