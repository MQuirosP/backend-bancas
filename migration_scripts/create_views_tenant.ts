import prisma from '../src/core/prismaClient';
import { logger } from '../src/core/logger';

async function recreateAllMVs() {
  const bancas = await prisma.banca.findMany({
    where: { isActive: true, schemaName: { not: 'public' } }
  });

  console.log(`🚀 Verificando Vistas Materializadas para ${bancas.length} bancas...`);

  for (const banca of bancas) {
    const schemaName = banca.schemaName;
    console.log(`Configurando MVs para ${banca.name} (${schemaName})...`);

    try {
      // 1. Crear Vista Materializada
      await prisma.$executeRawUnsafe(`
        CREATE MATERIALIZED VIEW IF NOT EXISTS "${schemaName}".mv_daily_account_summary AS
        SELECT 
          DATE(COALESCE(t."businessDate", t."createdAt")) as date,
          t."ventanaId",
          t."vendedorId",
          COUNT(DISTINCT t.id) as ticket_count,
          COALESCE(SUM(t."totalAmount"), 0) as total_sales,
          COALESCE(SUM(CASE WHEN j."isWinner" THEN j.payout ELSE 0 END), 0) as total_payouts,
          COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) as vendedor_commission,
          COALESCE(SUM(j."listeroCommissionAmount"), 0) as listero_commission,
          COALESCE(SUM(t."totalAmount"), 0) - 
          COALESCE(SUM(CASE WHEN j."isWinner" THEN j.payout ELSE 0 END), 0) - 
          COALESCE(SUM(j."listeroCommissionAmount"), 0) - 
          COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) as balance
        FROM "${schemaName}"."Ticket" t
        LEFT JOIN "${schemaName}"."Jugada" j ON j."ticketId" = t.id AND j."deletedAt" IS NULL
        WHERE t."deletedAt" IS NULL 
          AND t.status != 'CANCELLED'
          AND EXISTS (
            SELECT 1 FROM "${schemaName}"."Sorteo" s
            WHERE s.id = t."sorteoId"
            AND s.status = 'EVALUATED'
            AND s."deletedAt" IS NULL
          )
        GROUP BY DATE(COALESCE(t."businessDate", t."createdAt")), t."ventanaId", t."vendedorId";
      `);

      // 2. Índice Único
      await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS "idx_${schemaName}_mv_daily_summary_unique" 
        ON "${schemaName}".mv_daily_account_summary(date, "ventanaId", "vendedorId");
      `);

      // 3. Índice de Fecha
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "idx_${schemaName}_mv_daily_summary_date" 
        ON "${schemaName}".mv_daily_account_summary(date);
      `);

      console.log(`✅ ${banca.name} lista.`);
    } catch (e: any) {
      console.error(`❌ Error en ${banca.name}:`, e.message);
    }
  }
}

recreateAllMVs().then(() => process.exit(0));
