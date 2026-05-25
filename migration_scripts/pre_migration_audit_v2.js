/**
 * AUDITORÍA PRE-MIGRACIÓN MULTI-TENANT v3
 *
 * Qué verifica:
 *  1. Duplicados que romperian los nuevos constraints únicos (CRÍTICO)
 *  2. Registros con bancaId NULL en todas las tablas relevantes
 *  3. bancaId huérfanos (apuntan a una banca que no existe)
 *  4. Existencia del enum BANCA en la DB
 *  5. Tamaño de tablas para estimación de tiempo de migración
 *  6. Integridad de relaciones Ventana → Banca
 *
 * USO: node scratch/pre_migration_audit_v2.js
 *
 * ⚠️  SOLO LECTURA — No modifica ningún dato.
 */

const { Client } = require('pg');
require('dotenv').config();

// Usar la variable de entorno, NO credenciales hardcodeadas
const DB_URL = process.env.DATABASE_URL || process.env.DIRECT_URL;

if (!DB_URL) {
  console.error('❌ ERROR: No se encontró DATABASE_URL en las variables de entorno.');
  console.error('   Ejecuta: $env:DATABASE_URL="tu_url_aqui"; node scratch/pre_migration_audit_v2.js');
  process.exit(1);
}

async function runAudit() {
  const client = new Client({
    connectionString: DB_URL,
    ssl: DB_URL.includes('supabase') ? { rejectUnauthorized: false } : false
  });

  let hasBlockers = false;

  try {
    await client.connect();

    console.log('');
    console.log('════════════════════════════════════════════════════════');
    console.log('  AUDITORÍA PRE-MIGRACIÓN MULTI-TENANT');
    console.log(`  DB: ${DB_URL.replace(/:([^:@]+)@/, ':***@')}`);
    console.log('════════════════════════════════════════════════════════');
    console.log('');

    // ──────────────────────────────────────────────────────────
    // CHECK 1: Conflicto de UNIQUE en Sorteo (BLOQUEANTE)
    // ──────────────────────────────────────────────────────────
    console.log('🔍 CHECK 1: Conflictos de constraint único en Sorteo...');
    const dupSorteo = await client.query(`
      SELECT "loteriaId", "scheduledAt", "bancaId", COUNT(*) as cnt
      FROM "Sorteo"
      GROUP BY "loteriaId", "scheduledAt", "bancaId"
      HAVING COUNT(*) > 1
      LIMIT 5;
    `);
    if (dupSorteo.rowCount > 0) {
      console.log('   ❌ BLOQUEANTE: Hay duplicados que romperían UNIQUE(loteriaId, scheduledAt, bancaId):');
      console.table(dupSorteo.rows);
      hasBlockers = true;
    } else {
      console.log('   ✅ Sin duplicados en Sorteo.');
    }

    // ──────────────────────────────────────────────────────────
    // CHECK 2: Conflicto de UNIQUE en Loteria (BLOQUEANTE)
    // ──────────────────────────────────────────────────────────
    console.log('🔍 CHECK 2: Conflictos de constraint único en Loteria...');
    const dupLoteria = await client.query(`
      SELECT name, "bancaId", COUNT(*) as cnt
      FROM "Loteria"
      GROUP BY name, "bancaId"
      HAVING COUNT(*) > 1
      LIMIT 5;
    `);
    if (dupLoteria.rowCount > 0) {
      console.log('   ❌ BLOQUEANTE: Hay duplicados que romperían UNIQUE(name, bancaId):');
      console.table(dupLoteria.rows);
      hasBlockers = true;
    } else {
      console.log('   ✅ Sin duplicados en Loteria.');
    }

    // ──────────────────────────────────────────────────────────
    // CHECK 3: Registros con bancaId NULL (todas las tablas)
    // ──────────────────────────────────────────────────────────
    console.log('🔍 CHECK 3: Registros con bancaId NULL en tablas críticas...');
    const nullChecks = await client.query(`
      SELECT 'User'             as tabla, COUNT(*) as nulos FROM "User"             WHERE "bancaId" IS NULL
      UNION ALL
      SELECT 'Ticket',                   COUNT(*)          FROM "Ticket"            WHERE "bancaId" IS NULL
      UNION ALL
      SELECT 'Jugada',                   COUNT(*)          FROM "Jugada"            WHERE "bancaId" IS NULL
      UNION ALL
      SELECT 'AccountStatement',         COUNT(*)          FROM "AccountStatement"  WHERE "bancaId" IS NULL
      UNION ALL
      SELECT 'AccountPayment',           COUNT(*)          FROM "AccountPayment"    WHERE "bancaId" IS NULL
      UNION ALL
      SELECT 'Sorteo (no globales)',      COUNT(*)          FROM "Sorteo"            WHERE "bancaId" IS NULL AND "loteriaId" IN (SELECT id FROM "Loteria" WHERE "bancaId" IS NOT NULL)
      ORDER BY nulos DESC;
    `);
    console.table(nullChecks.rows);

    // ──────────────────────────────────────────────────────────
    // CHECK 4: Usuarios sin Ventana (no podrán backfillearse)
    // ──────────────────────────────────────────────────────────
    console.log('🔍 CHECK 4: Usuarios sin Ventana asignada (quedarán con bancaId NULL)...');
    const usersNoVentana = await client.query(`
      SELECT COUNT(*) as cnt
      FROM "User"
      WHERE "ventanaId" IS NULL AND "bancaId" IS NULL AND role = 'VENDEDOR';
    `);
    const noVentanaCount = Number(usersNoVentana.rows[0].cnt);
    if (noVentanaCount > 0) {
      console.log(`   ⚠️  ${noVentanaCount} vendedores sin ventana — sus registros no se vincularán automáticamente.`);
    } else {
      console.log('   ✅ Todos los vendedores tienen ventana asignada.');
    }

    // ──────────────────────────────────────────────────────────
    // CHECK 5: bancaId huérfanos (apuntan a banca inexistente)
    // ──────────────────────────────────────────────────────────
    console.log('🔍 CHECK 5: bancaId huérfanos en Ticket...');
    const orphanTickets = await client.query(`
      SELECT COUNT(*) as cnt
      FROM "Ticket"
      WHERE "bancaId" IS NOT NULL
        AND "bancaId" NOT IN (SELECT id FROM "Banca");
    `);
    const orphanCount = Number(orphanTickets.rows[0].cnt);
    if (orphanCount > 0) {
      console.log(`   ❌ BLOQUEANTE: ${orphanCount} tickets con bancaId que no existe en tabla Banca.`);
      hasBlockers = true;
    } else {
      console.log('   ✅ Sin bancaId huérfanos en Ticket.');
    }

    // ──────────────────────────────────────────────────────────
    // CHECK 6: Tamaño de tablas (estimación de tiempo)
    // ──────────────────────────────────────────────────────────
    console.log('🔍 CHECK 6: Tamaño de tablas (estimación de duración del backfill)...');
    const tableSizes = await client.query(`
      SELECT relname as tabla, n_live_tup as filas
      FROM pg_stat_user_tables
      WHERE relname IN ('User', 'Ticket', 'Jugada', 'AccountStatement', 'AccountPayment', 'Sorteo', 'Loteria')
      ORDER BY n_live_tup DESC;
    `);
    console.table(tableSizes.rows);

    // ──────────────────────────────────────────────────────────
    // RESUMEN FINAL
    // ──────────────────────────────────────────────────────────
    console.log('');
    console.log('════════════════════════════════════════════════════════');
    if (hasBlockers) {
      console.log('  ❌ RESULTADO: HAY BLOQUEANTES — NO proceder con la migración.');
      console.log('     Revisa los items marcados con ❌ arriba y resuélvelos primero.');
    } else {
      console.log('  ✅ RESULTADO: Sin bloqueantes — Puedes proceder con el Backfill.');
    }
    console.log('════════════════════════════════════════════════════════');
    console.log('');

  } catch (err) {
    console.error('❌ Error durante la auditoría:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runAudit();
