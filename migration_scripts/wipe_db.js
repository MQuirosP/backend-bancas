const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Wiping public schema...');
  await prisma.$executeRawUnsafe(`DROP SCHEMA public CASCADE;`);
  await prisma.$executeRawUnsafe(`CREATE SCHEMA public;`);
  await prisma.$executeRawUnsafe(`GRANT ALL ON SCHEMA public TO postgres;`);
  await prisma.$executeRawUnsafe(`GRANT ALL ON SCHEMA public TO public;`);
  await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;`);
  await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;`);
  console.log('Public schema wiped and extensions restored successfully!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
