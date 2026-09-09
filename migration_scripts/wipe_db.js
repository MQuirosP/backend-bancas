const { Client } = require('pg');
require('dotenv').config();

const DB_URL = process.env.DATABASE_URL;

if (!DB_URL) {
  console.error('❌ ERROR: No se encontró DATABASE_URL en .env');
  process.exit(1);
}

// Validación de seguridad para prevenir ejecuciones accidentales en remoto
if (!DB_URL.includes('localhost') && !DB_URL.includes('127.0.0.1')) {
  console.error('🛑 ABORTADO: wipe_db solo está permitido en base de datos LOCAL (localhost / 127.0.0.1).');
  console.error(`   DATABASE_URL actual: ${DB_URL}`);
  process.exit(1);
}

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    console.log('Wiping public schema en base de datos local...');
    await client.query(`DROP SCHEMA public CASCADE;`);
    await client.query(`CREATE SCHEMA public;`);
    await client.query(`GRANT ALL ON SCHEMA public TO postgres;`);
    await client.query(`GRANT ALL ON SCHEMA public TO public;`);
    await client.query(`CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;`);
    await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;`);
    console.log('✅ Public schema wiped y extensiones (citext, pg_trgm) restauradas con éxito.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('❌ Error al resetear esquema:', err);
  process.exit(1);
});

