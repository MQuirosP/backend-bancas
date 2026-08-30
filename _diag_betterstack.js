// Consultar Better Stack ClickHouse para tiempos de respuesta lentos reales
async function query(sql) {
  const res = await fetch('https://eu-nbg-2.logs.betterstack.com/clickhouse', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer 9X5WcnxjZT1uXWR24GQPgpbv',
      'Content-Type': 'text/plain',
    },
    body: sql,
  });
  const text = await res.text();
  return text;
}

async function main() {
  // 1. Ver la estructura de la tabla disponible
  console.log('=== ÚLTIMAS 5 FILAS CRUDAS ===');
  const sample = await query(`
    SELECT dt, raw
    FROM remote(t563335_backend_bancas_logs)
    ORDER BY dt DESC
    LIMIT 5
    FORMAT JSONEachRow
  `);
  console.log(sample.slice(0, 2000));

  // 2. Buscar logs de performance del dashboard (últimas 24h)
  console.log('\n=== LOGS DE PERFORMANCE DASHBOARD (últimas 24h) ===');
  const perfDash = await query(`
    SELECT dt, raw
    FROM remote(t563335_backend_bancas_logs)
    WHERE dt >= now() - INTERVAL 24 HOUR
      AND (raw ILIKE '%DASHBOARD_OPERATIONS%' OR raw ILIKE '%queryExecutionTime%' OR raw ILIKE '%durationMs%')
    ORDER BY dt DESC
    LIMIT 20
    FORMAT JSONEachRow
  `);
  console.log(perfDash || 'Sin resultados');

  // 3. Buscar requests con tiempo de respuesta > 1000ms (logs de Render tienen responseTimeMS)
  console.log('\n=== REQUESTS LENTOS (últimas 12h) ===');
  const slowReqs = await query(`
    SELECT dt, raw
    FROM remote(t563335_backend_bancas_logs)
    WHERE dt >= now() - INTERVAL 12 HOUR
      AND (raw ILIKE '%responseTimeMS%')
    ORDER BY dt DESC
    LIMIT 50
    FORMAT JSONEachRow
  `);
  // Parsear y filtrar los > 1000ms
  const lines = slowReqs.trim().split('\n').filter(Boolean);
  const slow = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const raw = obj.raw || '';
      const match = raw.match(/responseTimeMS=(\d+)/);
      if (match && parseInt(match[1]) >= 500) {
        slow.push({ dt: obj.dt, ms: parseInt(match[1]), raw: raw.slice(0, 300) });
      }
    } catch (e) {}
  }
  console.log(`Requests >= 500ms encontrados en últimas 12h: ${slow.length}`);
  for (const s of slow) {
    console.log(`  [${s.dt}] ${s.ms}ms | ${s.raw}`);
  }

  // 4. Buscar errores en las últimas 24h
  console.log('\n=== ERRORES (últimas 24h) ===');
  const errors = await query(`
    SELECT dt, raw
    FROM remote(t563335_backend_bancas_logs)
    WHERE dt >= now() - INTERVAL 24 HOUR
      AND (raw ILIKE '%"level":50%' OR raw ILIKE '"level":40' OR raw ILIKE '%ERROR%' OR raw ILIKE '%error%')
      AND raw NOT ILIKE '%REDIS%'
    ORDER BY dt DESC
    LIMIT 20
    FORMAT JSONEachRow
  `);
  console.log(errors.slice(0, 3000) || 'Sin errores');

  // 5. Buscar logs de SORTEO_EVALUATED_SUMMARY (tiempos)
  console.log('\n=== SORTEO_EVALUATED_SUMMARY (últimas 24h) ===');
  const evalSummary = await query(`
    SELECT dt, raw
    FROM remote(t563335_backend_bancas_logs)
    WHERE dt >= now() - INTERVAL 24 HOUR
      AND raw ILIKE '%EVALUATED_SUMMARY%'
    ORDER BY dt DESC
    LIMIT 15
    FORMAT JSONEachRow
  `);
  console.log(evalSummary || 'Sin resultados');
}

main().catch(console.error);
