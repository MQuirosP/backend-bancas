import path from 'path';
import dotenvSafe from 'dotenv-safe';

dotenvSafe.config({
  path: path.resolve(__dirname, '../../.env'),
  example: path.resolve(__dirname, '../../.env.example'),
  allowEmptyValues: true,
});

const env = process.env.NODE_ENV || 'development';
if (env === 'production') {
  console.error('❌ Bloqueado: "prisma migrate dev" no se permite en producción.');
  process.exit(1);
}

// Requerido: SHADOW local (tu Postgres en localhost)
const SHADOW = process.env.SHADOW_DATABASE_URL || '';
if (!SHADOW) {
  console.error('❌ Falta SHADOW_DATABASE_URL (debe apuntar a Postgres local).');
  process.exit(1);
}
try {
  const u = new URL(SHADOW);
  const host = (u.hostname || '').toLowerCase();
  if (!(host === 'localhost' || host === '127.0.0.1')) {
    console.error(`❌ SHADOW_DATABASE_URL debe ser local. Host actual: ${host}`);
    process.exit(1);
  }
} catch {
  console.error('❌ SHADOW_DATABASE_URL inválida.');
  process.exit(1);
}

// Requerido: DIRECT_URL (no pooler). Puede ser remoto (Supabase 5432).
const DIRECT = process.env.DIRECT_URL || '';
if (!DIRECT) {
  console.error('❌ Falta DIRECT_URL (usa el puerto directo 5432 de Supabase para migraciones).');
  process.exit(1);
}
try {
  const u = new URL(DIRECT);
  const port = (u.port || '').toString();
  const isPooler = port === '6543' || DIRECT.includes('pgbouncer=true');
  if (isPooler) {
    console.error('❌ DIRECT_URL apunta al pooler (6543/pgbouncer). Usa el puerto directo 5432.');
    process.exit(1);
  }
} catch {
  console.error('❌ DIRECT_URL inválida.');
  process.exit(1);
}

// OPCIONAL: evitar que la shadow sea igual que la main/direct (bug común)
const DB = process.env.DATABASE_URL || '';
try {
  if (DB) {
    const main = new URL(DB);
    const direct = new URL(DIRECT);
    const shadow = new URL(SHADOW);

    const sameAsMain =
      main.hostname === shadow.hostname &&
      main.port === shadow.port &&
      main.pathname === shadow.pathname;

    const sameAsDirect =
      direct.hostname === shadow.hostname &&
      direct.port === shadow.port &&
      direct.pathname === shadow.pathname;

    if (sameAsMain || sameAsDirect) {
      console.error('❌ La SHADOW_DATABASE_URL no puede ser la misma base que DATABASE_URL/DIRECT_URL.');
      process.exit(1);
    }
  }
} catch {
  // si alguna URL falla, ya se validó antes lo crítico: shadow y direct.
}

console.log('✅ safe-migrate-dev: OK');
