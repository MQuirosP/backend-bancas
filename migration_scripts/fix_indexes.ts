import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    console.log('🧹 Limpiando índices problemáticos pre-migración...');

    const indexesToDrop = [
        // Índices únicos antiguos que ahora necesitan bancaId
        '"Loteria_name_key"',
        '"Sorteo_loteriaId_scheduledAt_key"',
        '"AccountPayment_idempotencyKey_key"',
        
        // Índices únicos que Prisma a veces falla en recrear limpiamente
        '"BancaLoteriaSetting_bancaId_loteriaId_key"',
        '"MonthlyClosingBalance_closingMonth_dimension_vendedorId_vent_key"'
    ];

    for (const indexName of indexesToDrop) {
        try {
            await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS ${indexName} CASCADE;`);
            console.log(`✅ Índice eliminado (si existía): ${indexName}`);
        } catch (e) {
            console.log(`⚠️  Aviso al eliminar ${indexName}: ${(e as Error).message}`);
        }
    }

    console.log('🎉 Limpieza de índices completada. Ya puedes ejecutar npx prisma db push.');
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
