import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

const prisma = new PrismaClient();

async function main() {
  console.log("🚀 Iniciando ejecución de Vistas SQL a través de Prisma...");

  try {
    // 1. Ejecutar las vistas de migrate_views_tenant.sql
    const sqlPath = path.join(__dirname, "migrate_views_tenant.sql");
    const sqlContent = fs.readFileSync(sqlPath, "utf-8");

    console.log("Ejecutando migrate_views_tenant.sql...");
    
    // Desactivar el timeout de la sesión actual de Prisma
    console.log("Desactivando timeout de la conexión (SET statement_timeout = 0)...");
    await prisma.$executeRawUnsafe("SET statement_timeout = 0;");

    // Separamos por comandos porque a veces ejecutar todo el bloque falla
    const statements = sqlContent
      .replace(/BEGIN;/gi, '')
      .replace(/COMMIT;/gi, '')
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const statement of statements) {
      if (statement.startsWith('--')) continue; // Saltar comentarios sueltos
      console.log(`Ejecutando: ${statement.substring(0, 50)}...`);
      await prisma.$executeRawUnsafe(statement);
    }
    
    console.log("✅ Vistas antiguas (mv_daily_account_summary, mv_diario_ventas_totales) migradas.");

    // 2. Ejecutar la vista de SorteoVentasStats
    console.log("Ejecutando creación de SorteoVentasStats...");
    
    await prisma.$executeRawUnsafe(`DROP MATERIALIZED VIEW IF EXISTS "SorteoVentasStats" CASCADE`);
    
    await prisma.$executeRawUnsafe(`
      CREATE MATERIALIZED VIEW "SorteoVentasStats" AS
      SELECT 
          t."sorteoId",
          s."bancaId",
          COUNT(t.id) as "totalTickets",
          SUM(CASE WHEN t.status = 'ACTIVE' THEN 1 ELSE 0 END) as "activeTickets",
          SUM(CASE WHEN t.status = 'CANCELLED' THEN 1 ELSE 0 END) as "cancelledTickets",
          COALESCE(SUM(CASE WHEN t.status = 'ACTIVE' THEN t.total ELSE 0 END), 0) as "totalVentas",
          COALESCE(SUM(CASE WHEN t.status = 'CANCELLED' THEN t.total ELSE 0 END), 0) as "totalAnulado"
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
