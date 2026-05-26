import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Creando índice concurrente para el pool de sesiones de vendedores...");

  try {
    // Verificar si el índice ya existe
    const indexExists: any[] = await prisma.$queryRaw`
      SELECT 1 
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'idx_user_banca_vendedor'
      AND n.nspname = 'public';
    `;

    if (indexExists.length > 0) {
      console.log("✅ El índice 'idx_user_banca_vendedor' ya existe. Omitiendo creación.");
      return;
    }

    console.log("⏳ Creando índice 'idx_user_banca_vendedor'. Esto puede tomar un momento en bases de datos grandes...");
    
    // Crear el índice concurrentemente (requiere que se ejecute fuera de una transacción de Prisma regular)
    await prisma.$queryRawUnsafe(`
      CREATE INDEX CONCURRENTLY idx_user_banca_vendedor
      ON "User"("bancaId")
      WHERE role = 'VENDEDOR';
    `);

    console.log("✅ Índice 'idx_user_banca_vendedor' creado exitosamente.");
  } catch (e) {
    console.error("❌ Error creando el índice:", e);
    // process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
