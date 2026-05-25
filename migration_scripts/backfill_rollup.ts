import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('🚀 Iniciando copiado de datos a ResumenCierreDiario desde la Vista Materializada...');
  
  // Como la Vista Materializada (mv_diario_ventas_totales) ya tiene la data agregada 
  // exactamente con las mismas columnas que ResumenCierreDiario, podemos hacer un
  // INSERT directo ultra-rápido en lugar de procesar fila por fila en TypeScript.
  
  await prisma.$executeRawUnsafe(`
    INSERT INTO "ResumenCierreDiario" (
      id, "bancaId", "businessDate", "vendedorId", "ventanaId", 
      "loteriaId", "sorteoId", tipo, banda, "totalVendida", 
      ganado, "comisionTotal", "ticketsCount", "jugadasCount", 
      "createdAt", "updatedAt"
    )
    SELECT 
      gen_random_uuid(),
      "bancaId",
      "businessDate",
      "vendedorId",
      "ventanaId",
      "loteriaId",
      "sorteoId",
      CAST(tipo AS "BetType"),
      banda,
      "totalVendida",
      ganado,
      "comisionTotal",
      "ticketsCount",
      "jugadasCount",
      NOW(),
      NOW()
    FROM mv_diario_ventas_totales
    ON CONFLICT DO NOTHING;
  `);
  
  const count = await prisma.resumenCierreDiario.count();
  console.log('✅ Backfill completado instantáneamente. Total filas insertadas en ResumenCierreDiario:', count);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
