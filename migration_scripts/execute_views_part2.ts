import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🚀 Iniciando Parte 2: Funciones y SorteoVentasStats...");

  try {
    // 1. Crear las funciones de refresco (ahora completas, sin separarlas por punto y coma)
    console.log("Creando funciones de refresco...");
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION refresh_daily_account_summary()
      RETURNS void AS $$
      BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_account_summary;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION refresh_diario_ventas_totales()
      RETURNS void AS $$
      BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_diario_ventas_totales;
      END;
      $$ LANGUAGE plpgsql;
    `);

    console.log("✅ Funciones de refresco creadas.");

    // 2. Crear la vista de SorteoVentasStats
    console.log("Creando vista SorteoVentasStats...");
    await prisma.$executeRawUnsafe(`DROP MATERIALIZED VIEW IF EXISTS "SorteoVentasStats" CASCADE`);
    
    await prisma.$executeRawUnsafe(`
      CREATE MATERIALIZED VIEW "SorteoVentasStats" AS
      SELECT 
          t."sorteoId",
          s."bancaId",
          COUNT(t.id) as "totalTickets",
          SUM(CASE WHEN t.status = 'ACTIVE' THEN 1 ELSE 0 END) as "activeTickets",
          SUM(CASE WHEN t.status = 'CANCELLED' THEN 1 ELSE 0 END) as "cancelledTickets",
          COALESCE(SUM(CASE WHEN t.status = 'ACTIVE' THEN t."totalAmount" ELSE 0 END), 0) as "totalVentas",
          COALESCE(SUM(CASE WHEN t.status = 'CANCELLED' THEN t."totalAmount" ELSE 0 END), 0) as "totalAnulado"
      FROM "Ticket" t
      JOIN "Sorteo" s ON t."sorteoId" = s.id
      GROUP BY t."sorteoId", s."bancaId"
    `);
    
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX "SorteoVentasStats_sorteoId_idx" ON "SorteoVentasStats"("sorteoId")`);
    
    console.log("✅ Vista SorteoVentasStats creada con bancaId.");
    console.log("🎉 TODAS LAS VISTAS SE HAN CREADO EXITOSAMENTE.");

  } catch (e) {
    console.error("❌ Error ejecutando SQL:", e);
  } finally {
    await prisma.$disconnect();
  }
}

main();
