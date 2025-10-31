import dotenv from 'dotenv';
import path from 'path';

// Cargar variables de entorno de test ANTES de cualquier import
dotenv.config({ path: path.resolve(__dirname, '../.env.test') });

// Guard de seguridad: NO permitir tests contra producción
const dbUrl = process.env.DATABASE_URL || '';
const nodeEnv = process.env.NODE_ENV;

console.log('\n🔧 Configuring test environment...\n');

// 1. Verificar NODE_ENV
if (nodeEnv !== 'test') {
  console.error('❌ FATAL ERROR: NODE_ENV debe ser "test"');
  console.error(`   Actual: NODE_ENV="${nodeEnv}"`);
  console.error('\n   Ejecuta los tests con: npm test\n');
  process.exit(1);
}

// 2. Verificar que NO estamos contra producción
const isDangerousEnvironment =
  dbUrl.includes('supabase.com') ||
  dbUrl.includes('production') ||
  dbUrl.includes('prod') ||
  dbUrl.includes('render.com') ||
  dbUrl.includes('amazonaws.com');

if (isDangerousEnvironment) {
  console.error('\n❌ FATAL ERROR: Tests configurados contra base de datos de producción!\n');
  console.error('   DATABASE_URL:', dbUrl);
  console.error('\n   ⚠️  POR SEGURIDAD, LOS TESTS NO SE EJECUTARÁN\n');
  console.error('   Solución:');
  console.error('   1. Crear archivo .env.test con DATABASE_URL de PostgreSQL local');
  console.error('   2. Ejemplo: DATABASE_URL=postgresql://postgres:test@localhost:5433/bancas_test');
  console.error('   3. Ejecutar: npm test\n');
  process.exit(1);
}

// 3. Verificar que es una base de datos local (localhost)
const isLocalDatabase = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');

if (!isLocalDatabase) {
  console.error('\n❌ FATAL ERROR: Tests deben ejecutarse contra base de datos local (localhost)');
  console.error('   DATABASE_URL:', dbUrl);
  console.error('\n   Esperado: postgresql://...@localhost:5432/bancas');
  console.error('   Por seguridad, los tests NO se ejecutarán.\n');
  process.exit(1);
}

// 4. Todo OK
console.log('✅ Test environment configured successfully');
console.log(`   NODE_ENV: ${nodeEnv}`);
console.log(`   DATABASE: ${dbUrl.replace(/:[^:@]+@/, ':***@')}`);
console.log('');
