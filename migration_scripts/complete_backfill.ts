import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const BATCH_SIZE = 50000;
const INITIAL_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 5000;

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function executeBatchUpdate(
    entityName: string, 
    query: string, 
    checkQuery: string
) {
    console.log(`\n🔄 Iniciando backfill para: ${entityName} (Lotes de ${BATCH_SIZE})`);
    
    let totalUpdated = 0;
    let currentBackoff = INITIAL_BACKOFF_MS;
    let hasMore = true;

    while (hasMore) {
        try {
            // Ejecutamos el lote usando CTE para aislar exactamente BATCH_SIZE filas
            const updatedRows = await prisma.$executeRawUnsafe(query);
            
            if (updatedRows > 0) {
                totalUpdated += updatedRows;
                console.log(`   [${entityName}] Lote procesado: ${updatedRows} filas. (Total acumulado: ${totalUpdated})`);
                
                // Si el lote se procesó bien, reseteamos el backoff
                currentBackoff = INITIAL_BACKOFF_MS;
                
                // Pequeña pausa para dejar respirar el pool de conexiones (Anti-Timeout)
                await sleep(50);
            }

            // Comprobamos si quedan más nulos
            const remaining: any = await prisma.$queryRawUnsafe(checkQuery);
            const count = Number(remaining[0].count);
            
            if (count === 0) {
                hasMore = false;
                console.log(`✅ [${entityName}] Completado. Total actualizado: ${totalUpdated}`);
            }

        } catch (error) {
            console.warn(`⚠️ Error procesando lote de ${entityName}. Aplicando backoff de ${currentBackoff}ms...`, error);
            await sleep(currentBackoff);
            
            // Exponential backoff
            currentBackoff = Math.min(currentBackoff * 2, MAX_BACKOFF_MS);
        }
    }
}

async function main() {
    console.log('🚀 Iniciando Curación de Datos (Anti-Timeout / Batching)...');

    try {
        // 1. USUARIOS
        await executeBatchUpdate(
            'User',
            `WITH batch AS (SELECT id FROM "User" WHERE "bancaId" IS NULL LIMIT ${BATCH_SIZE})
             UPDATE "User" u SET "bancaId" = v."bancaId" 
             FROM batch, "Ventana" v WHERE u.id = batch.id AND u."ventanaId" = v.id;`,
            `SELECT count(*) as count FROM "User" WHERE "bancaId" IS NULL AND "ventanaId" IS NOT NULL;`
        );

        // 2. TICKETS
        await executeBatchUpdate(
            'Ticket',
            `WITH batch AS (SELECT id FROM "Ticket" WHERE "bancaId" IS NULL LIMIT ${BATCH_SIZE})
             UPDATE "Ticket" t SET "bancaId" = v."bancaId" 
             FROM batch, "Ventana" v WHERE t.id = batch.id AND t."ventanaId" = v.id;`,
            `SELECT count(*) as count FROM "Ticket" WHERE "bancaId" IS NULL;`
        );

        // 3. JUGADAS (El más pesado, 3.6M+)
        await executeBatchUpdate(
            'Jugada',
            `WITH batch AS (SELECT id FROM "Jugada" WHERE "bancaId" IS NULL LIMIT ${BATCH_SIZE})
             UPDATE "Jugada" j SET "bancaId" = t."bancaId" 
             FROM batch, "Ticket" t WHERE j.id = batch.id AND j."ticketId" = t.id;`,
            `SELECT count(*) as count FROM "Jugada" WHERE "bancaId" IS NULL;`
        );

        // 4. ACCOUNT STATEMENTS
        await executeBatchUpdate(
            'AccountStatement',
            `WITH batch AS (SELECT id FROM "AccountStatement" WHERE "bancaId" IS NULL LIMIT ${BATCH_SIZE})
             UPDATE "AccountStatement" a SET "bancaId" = v."bancaId" 
             FROM batch, "Ventana" v WHERE a.id = batch.id AND a."ventanaId" = v.id;`,
            `SELECT count(*) as count FROM "AccountStatement" WHERE "bancaId" IS NULL AND "ventanaId" IS NOT NULL;`
        );

        // 5. ACCOUNT PAYMENTS
        await executeBatchUpdate(
            'AccountPayment',
            `WITH batch AS (SELECT id FROM "AccountPayment" WHERE "bancaId" IS NULL LIMIT ${BATCH_SIZE})
             UPDATE "AccountPayment" p SET "bancaId" = v."bancaId" 
             FROM batch, "Ventana" v WHERE p.id = batch.id AND p."ventanaId" = v.id;`,
            `SELECT count(*) as count FROM "AccountPayment" WHERE "bancaId" IS NULL AND "ventanaId" IS NOT NULL;`
        );

        console.log('\n🎉 Backfill completado exitosamente.');
    } catch (e) {
        console.error('❌ Error fatal durante el backfill:', e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
