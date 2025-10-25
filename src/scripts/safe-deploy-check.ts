import path from 'path';
import dotenvSafe from 'dotenv-safe';

// Carga .env (y valida contra .env.example si lo usas)
dotenvSafe.config({
  path: path.resolve(__dirname, '../../.env'),
  example: path.resolve(__dirname, '../../.env.example'),
  allowEmptyValues: true,
});

const DIRECT = process.env.DIRECT_URL || '';
if (!DIRECT) {
  console.error('❌ Falta DIRECT_URL para "prisma migrate deploy".');
  process.exit(1);
}

try {
  const u = new URL(DIRECT);
  const port = (u.port || '').toString();

  // Pooler típico de Supabase: 6543 o query pgbouncer=true
  const isPooler = port === '6543' || DIRECT.includes('pgbouncer=true');
  if (isPooler) {
    console.error('❌ DIRECT_URL apunta al pooler (6543/pgbouncer). Usa el puerto directo 5432.');
    process.exit(1);
  }
} catch {
  console.error('❌ DIRECT_URL inválida.');
  process.exit(1);
}

// No uses shadow en deploy remoto (staging/prod)
if (process.env.SHADOW_DATABASE_URL) {
  console.error('❌ No definas SHADOW_DATABASE_URL en staging/prod para "migrate deploy".');
  process.exit(1);
}

console.log('✅ safe-deploy-check: OK');
