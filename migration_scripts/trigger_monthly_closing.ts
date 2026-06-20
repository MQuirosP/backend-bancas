import { executeMonthlyClosing } from '../src/jobs/monthlyClosing.job';
import { warmupConnection } from '../src/core/connectionWarmup';
import prisma from '../src/core/prismaClient';

async function main() {
  console.log("==========================================");
  console.log("🔥 INICIANDO CIERRE MENSUAL MANUAL");
  console.log("==========================================");

  // Calentando conexión
  await warmupConnection({ useDirect: false, context: 'manualMonthlyClosing' });

  try {
    // Si no le pasamos parámetros, el job calcula automáticamente el mes anterior (Mayo)
    const result = await executeMonthlyClosing();
    
    console.log("\n✅ RESULTADO DEL CIERRE:");
    console.log(`Mes cerrado: ${result.closingMonth}`);
    console.log(`Vendedores procesados con éxito: ${result.vendedores.success} (Errores: ${result.vendedores.errors})`);
    console.log(`Ventanas procesadas con éxito: ${result.ventanas.success} (Errores: ${result.ventanas.errors})`);
    console.log(`Bancas procesadas con éxito: ${result.bancas.success} (Errores: ${result.bancas.errors})`);
    
    if (result.success) {
      console.log("\n🎉 CIERRE MENSUAL COMPLETADO SIN ERRORES.");
    } else {
      console.log("\n⚠️ CIERRE MENSUAL FINALIZÓ CON ALGUNOS ERRORES (Revisa los logs).");
    }
  } catch (error) {
    console.error("❌ Error catastrófico ejecutando el cierre:", error);
  } finally {
    await prisma.$disconnect();
    process.exit(0);
  }
}

main();
