const { Client } = require('pg');
const DIRECT_URL = 'postgresql://postgres.xhwxiofujvoaszojcoml:EAnS8hLM4rXZjayd@aws-1-us-east-1.pooler.supabase.com:5432/postgres?connection_limit=3';

async function runQuery(client, label, sql) {
  console.log(`\n=== ${label} ===`);
  try {
    const res = await client.query(sql);
    return res.rows;
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
    return [];
  }
}

async function main() {
  const client = new Client({ connectionString: DIRECT_URL });
  await client.connect();
  console.log('Conectado a Supabase OK\n');

  // Fecha CR de hoy
  const cr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Costa_Rica' }).format(new Date());
  const monthStart = cr.slice(0, 8) + '01';
  console.log(`Fecha CR hoy: ${cr} | Inicio del mes: ${monthStart}`);

  // 1. Tamaños de tablas
  const tables = await runQuery(client, 'TAMAÑO DE TABLAS CRÍTICAS', `
    SELECT relname AS tabla, n_live_tup AS filas,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS size
    FROM pg_class c
    JOIN pg_stat_user_tables s ON s.relname = c.relname
    WHERE s.relname IN ('Ticket','Jugada','AccountStatement','AccountPayment','ResumenCierreDiario','Sorteo')
    ORDER BY n_live_tup DESC
  `);
  for (const r of tables) console.log(`  ${r.tabla}: ${Number(r.filas).toLocaleString()} filas | ${r.size}`);

  // 2. Índices de AccountStatement
  const idxStmt = await runQuery(client, 'ÍNDICES EN AccountStatement', `
    SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'AccountStatement' ORDER BY indexname
  `);
  if (idxStmt.length === 0) console.log('  ⚠️  SIN ÍNDICES adicionales (solo PK implícita)');
  else for (const r of idxStmt) console.log(`  ${r.indexname}\n    ${r.indexdef}`);

  // 3. Índices de AccountPayment
  const idxPay = await runQuery(client, 'ÍNDICES EN AccountPayment', `
    SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'AccountPayment' ORDER BY indexname
  `);
  if (idxPay.length === 0) console.log('  ⚠️  SIN ÍNDICES adicionales (solo PK implícita)');
  else for (const r of idxPay) console.log(`  ${r.indexname}\n    ${r.indexdef}`);

  // 4. Volumen de AccountPayment mes actual
  const payVol = await runQuery(client, 'VOLUMEN AccountPayment (mes actual)', `
    SELECT COUNT(*) AS total_rows,
           COUNT(DISTINCT "ventanaId") AS ventanas,
           COUNT(DISTINCT "vendedorId") AS vendedores
    FROM "AccountPayment"
    WHERE date >= '${monthStart}'::date AND "isReversed" = false
  `);
  if (payVol[0]) console.log(`  Filas: ${payVol[0].total_rows} | Ventanas: ${payVol[0].ventanas} | Vendedores: ${payVol[0].vendedores}`);

  // 5. Volumen de AccountStatement mes actual
  const stmtVol = await runQuery(client, 'VOLUMEN AccountStatement (mes actual)', `
    SELECT COUNT(*) AS total_rows,
           COUNT(DISTINCT "ventanaId") AS ventanas,
           COUNT(DISTINCT "vendedorId") AS vendedores
    FROM "AccountStatement"
    WHERE date >= '${monthStart}'::date
  `);
  if (stmtVol[0]) console.log(`  Filas: ${stmtVol[0].total_rows} | Ventanas: ${stmtVol[0].ventanas} | Vendedores: ${stmtVol[0].vendedores}`);

  // 6. EXPLAIN ANALYZE: AccountPayment findMany actual (sin agrupar)
  const ep1 = await runQuery(client, 'EXPLAIN: AccountPayment findMany (actual - trae todo a Node.js)', `
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT "ventanaId", type, amount
    FROM "AccountPayment"
    WHERE date >= '${monthStart}'::timestamp
      AND date <= '${cr} 23:59:59'::timestamp
      AND "isReversed" = false
      AND "ventanaId" IS NOT NULL
  `);
  ep1.forEach(r => console.log(Object.values(r)[0]));

  // 7. EXPLAIN ANALYZE: CTE propuesta (payment_agg + winner_agg)
  const ep2 = await runQuery(client, 'EXPLAIN: payment_agg CTE propuesta (agrega en SQL)', `
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    WITH payment_agg AS (
      SELECT "ventanaId",
             COALESCE(SUM(CASE WHEN type='payment' THEN amount ELSE 0 END), 0) AS total_paid,
             COALESCE(SUM(CASE WHEN type='collection' THEN amount ELSE 0 END), 0) AS total_collected
      FROM "AccountPayment"
      WHERE date::date BETWEEN '${monthStart}'::date AND '${cr}'::date
        AND "vendedorId" IS NULL AND "isReversed" = false
      GROUP BY "ventanaId"
    )
    SELECT v.id, v.name, COALESCE(pa.total_paid,0), COALESCE(pa.total_collected,0)
    FROM "Ventana" v
    LEFT JOIN payment_agg pa ON pa."ventanaId" = v.id
    WHERE v."isActive" = true
  `);
  ep2.forEach(r => console.log(Object.values(r)[0]));

  // 8. EXPLAIN ANALYZE: AccountStatement query principal de calculateGanancia
  const ep3 = await runQuery(client, 'EXPLAIN: AccountStatement calculateGanancia actual', `
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT
      v.id AS ventana_id, v.name AS ventana_name, v."isActive" AS is_active,
      COALESCE(SUM(a."totalSales"), 0) AS total_sales,
      COALESCE(SUM(a."totalPayouts"), 0) AS total_payouts,
      COALESCE(SUM(a."ticketCount"), 0) AS total_tickets,
      COALESCE(SUM(a."vendedorCommission"), 0) AS commission_user,
      COALESCE(SUM(a."listeroCommission"), 0) AS commission_ventana
    FROM "Ventana" v
    LEFT JOIN "AccountStatement" a ON a."ventanaId" = v.id
      AND a.date BETWEEN '${monthStart}'::date AND '${cr}'::date
      AND a."vendedorId" IS NULL
    WHERE v."isActive" = true
    GROUP BY v.id, v.name, v."isActive"
  `);
  ep3.forEach(r => console.log(Object.values(r)[0]));

  // 9. seq_scan stats (sin pg_stat_statements)
  const seqScans = await runQuery(client, 'SEQ_SCAN STATS (alto = posible índice faltante)', `
    SELECT relname AS tabla, seq_scan, seq_tup_read, idx_scan, idx_tup_fetch,
           CASE WHEN (seq_scan + idx_scan) > 0 
                THEN ROUND(100.0 * seq_scan / (seq_scan + idx_scan), 1)
                ELSE 0 END AS seq_pct
    FROM pg_stat_user_tables
    WHERE relname IN ('Ticket','Jugada','AccountStatement','AccountPayment','Sorteo')
    ORDER BY seq_scan DESC
  `);
  for (const r of seqScans) {
    console.log(`  ${r.tabla}: seq_scan=${r.seq_scan} (${r.seq_pct}%) | idx_scan=${r.idx_scan} | seq_tup_read=${Number(r.seq_tup_read).toLocaleString()}`);
  }

  // 10. pg_stat_statements si está disponible
  const slowQ = await runQuery(client, 'TOP QUERIES LENTAS (pg_stat_statements)', `
    SELECT LEFT(query, 200) AS q, calls,
           ROUND(mean_exec_time::numeric, 1) AS mean_ms,
           ROUND(max_exec_time::numeric, 1) AS max_ms,
           ROUND(stddev_exec_time::numeric, 1) AS stddev_ms
    FROM pg_stat_statements
    WHERE calls > 3 AND query NOT ILIKE '%pg_stat%'
      AND (query ILIKE '%AccountStatement%' OR query ILIKE '%AccountPayment%' OR query ILIKE '%evaluatedSummary%')
    ORDER BY mean_exec_time DESC
    LIMIT 10
  `);
  for (const r of slowQ) {
    console.log(`  [calls:${r.calls} | mean:${r.mean_ms}ms | max:${r.max_ms}ms | stddev:${r.stddev_ms}ms]\n  ${r.q}\n`);
  }

  await client.end();
  console.log('\n✅ Diagnóstico completado.');
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
