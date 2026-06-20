import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting SorteosAutoConfig Database-Level Correction & Unique Index Migration...\n');

  // 1. Fetch all configurations
  const configs = await prisma.sorteosAutoConfig.findMany({
    orderBy: { createdAt: 'asc' }
  });

  console.log(`Found ${configs.length} SorteosAutoConfig records.`);

  // 2. Identify and handle duplicates for bancaId: null (global)
  const globalConfigs = configs.filter(c => c.bancaId === null);
  if (globalConfigs.length > 1) {
    console.log(`\n[DEDUPLICATION] Detected ${globalConfigs.length} global configs. Deduplicating...`);
    const primary = globalConfigs[0];
    const duplicates = globalConfigs.slice(1);

    // Merge the most recent execution times
    let latestOpen = primary.lastOpenExecution;
    let latestCreate = primary.lastCreateExecution;
    let latestClose = primary.lastCloseExecution;
    let latestOpenCount = primary.lastOpenCount;
    let latestCreateCount = primary.lastCreateCount;
    let latestCloseCount = primary.lastCloseCount;

    for (const dup of duplicates) {
      if (dup.lastOpenExecution && (!latestOpen || dup.lastOpenExecution > latestOpen)) {
        latestOpen = dup.lastOpenExecution;
        latestOpenCount = dup.lastOpenCount;
      }
      if (dup.lastCreateExecution && (!latestCreate || dup.lastCreateExecution > latestCreate)) {
        latestCreate = dup.lastCreateExecution;
        latestCreateCount = dup.lastCreateCount;
      }
      if (dup.lastCloseExecution && (!latestClose || dup.lastCloseExecution > latestClose)) {
        latestClose = dup.lastCloseExecution;
        latestCloseCount = dup.lastCloseCount;
      }
    }

    console.log('Merged latest execution times:');
    console.log(`- lastOpenExecution: ${latestOpen ? latestOpen.toISOString() : 'never'}`);
    console.log(`- lastCreateExecution: ${latestCreate ? latestCreate.toISOString() : 'never'}`);
    console.log(`- lastCloseExecution: ${latestClose ? latestClose.toISOString() : 'never'}`);

    // Update the primary record
    await prisma.sorteosAutoConfig.update({
      where: { id: primary.id },
      data: {
        lastOpenExecution: latestOpen,
        lastOpenCount: latestOpenCount,
        lastCreateExecution: latestCreate,
        lastCreateCount: latestCreateCount,
        lastCloseExecution: latestClose,
        lastCloseCount: latestCloseCount,
        autoOpenEnabled: globalConfigs.some(c => c.autoOpenEnabled),
        autoCreateEnabled: globalConfigs.some(c => c.autoCreateEnabled),
        autoCloseEnabled: globalConfigs.some(c => c.autoCloseEnabled),
      }
    });

    // Delete duplicates
    const duplicateIds = duplicates.map(d => d.id);
    await prisma.sorteosAutoConfig.deleteMany({
      where: { id: { in: duplicateIds } }
    });

    console.log(`Successfully updated primary config (${primary.id}) and deleted duplicates:`, duplicateIds);
  } else {
    console.log('\nNo global duplicates found.');
  }

  // 3. Apply unique indexes to prevent future duplicates permanently
  console.log('\n[MIGRATION] Enforcing unique constraints at the database level...');

  try {
    // 3.1 Partial unique index for global config (where bancaId is null)
    // Only one row with bancaId IS NULL can ever exist
    await prisma.$executeRawUnprepared(`
      CREATE UNIQUE INDEX IF NOT EXISTS "SorteosAutoConfig_bancaId_null_uniq_idx" 
      ON "SorteosAutoConfig" ((1)) 
      WHERE "bancaId" IS NULL;
    `);
    console.log('✅ Unique index created: "SorteosAutoConfig_bancaId_null_uniq_idx" (Allows only one global null config)');

    // 3.2 Partial unique index for banca specific config (where bancaId is not null)
    // Only one row per distinct bancaId can exist
    await prisma.$executeRawUnprepared(`
      CREATE UNIQUE INDEX IF NOT EXISTS "SorteosAutoConfig_bancaId_not_null_uniq_idx" 
      ON "SorteosAutoConfig" ("bancaId") 
      WHERE "bancaId" IS NOT NULL;
    `);
    console.log('✅ Unique index created: "SorteosAutoConfig_bancaId_not_null_uniq_idx" (Allows only one config per banca)');

    console.log('\nDatabase correction completed successfully! Future duplicates are now impossible.');
  } catch (error) {
    console.error('\n❌ Error applying unique indexes in the database:', error);
  }

  await prisma.$disconnect();
}

main();
