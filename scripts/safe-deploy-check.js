// Script de verificación de seguridad antes de aplicar migraciones
// Previene aplicar migraciones accidentalmente en ambientes incorrectos

const { config } = require('dotenv');
const path = require('path');

// Cargar variables de entorno desde .env.local
const envPath = path.resolve(process.cwd(), '.env.local');
config({ path: envPath });

const REQUIRED_VARS = ['DATABASE_URL', 'DIRECT_URL'];
const PRODUCTION_INDICATORS = ['supabase.co', 'amazonaws.com', 'azure.com'];

async function main() {
  // Usar import dinámico para chalk v5 (ESM-only)
  const chalk = await import('chalk').then(m => m.default);

  console.log(chalk.blue('\n🔍 Verificando configuración de base de datos...\n'));

  // 1. Verificar que existan las variables requeridas
  for (const varName of REQUIRED_VARS) {
    if (!process.env[varName]) {
      console.error(chalk.red(`❌ ERROR: Variable de entorno ${varName} no está definida`));
      console.error(chalk.yellow(`\nSolución: Define ${varName} en tu archivo .env o .env.local\n`));
      process.exit(1);
    }
  }

  const dbUrl = process.env.DATABASE_URL || '';
  const directUrl = process.env.DIRECT_URL || '';

  // 2. Detectar si es producción
  const isProduction = PRODUCTION_INDICATORS.some(
    indicator => dbUrl.includes(indicator) || directUrl.includes(indicator)
  );

  // 3. Mostrar información de la base de datos (ofuscando credenciales)
  const safeUrl = dbUrl.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
  console.log(chalk.cyan('📊 Información de conexión:'));
  console.log(chalk.gray(`  DATABASE_URL: ${safeUrl}`));

  if (isProduction) {
    console.log(chalk.yellow('\n⚠️  ADVERTENCIA: Detectada base de datos de PRODUCCIÓN'));
    console.log(chalk.yellow('   Las migraciones se aplicarán en producción\n'));
  } else {
    console.log(chalk.green('\n✅ Base de datos de desarrollo/local detectada\n'));
  }

  // 4. Verificar NODE_ENV
  if (process.env.NODE_ENV === 'production' && !isProduction) {
    console.warn(chalk.yellow('⚠️  NODE_ENV=production pero DATABASE_URL no parece producción'));
  }

  console.log(chalk.green('✅ Verificaciones completadas. Procediendo con migraciones...\n'));
}

main().catch(err => {
  console.error('Error en verificación:', err);
  process.exit(1);
});
