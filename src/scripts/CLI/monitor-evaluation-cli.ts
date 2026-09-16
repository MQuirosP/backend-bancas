import https from 'https';

// ============================================================================
// Monitor de Evaluación de Sorteos y Tráfico de Terminales - Backend Bancas
// ============================================================================
// Uso en Render Shell o Local:
//   npm run monitor -- 5
//   node dist/scripts/CLI/monitor-evaluation-cli.js [minutos_atras] [--detail]
//   O a través de la suite interactiva: npm run ops -> Opción [6]
// ============================================================================

async function runQuery(sql: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'eu-fsn-3-connect.betterstackdata.com',
      port: 443,
      path: '/',
      method: 'POST',
      auth: 'uU1EYcbZhqwNJFteumO55IPD5B02j2dSP:blu9rYvWzd63lsK3ZGUYxDkdyxW2jyjrbUbIxty2iQbW5nEk2vyZ5Cz4g5yulNUC',
      headers: {
        'Content-Type': 'text/plain',
        'Content-Length': Buffer.byteLength(sql),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode === 200) {
          const rows = data
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              try {
                return JSON.parse(line);
              } catch {
                return { raw: line };
              }
            });
          resolve(rows);
        } else {
          reject(new Error(`ClickHouse error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(sql);
    req.end();
  });
}

function formatCRTime(dateStr: string): string {
  try {
    const d = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
    const crDate = new Date(d.getTime() - 6 * 3600 * 1000);
    return crDate.toISOString().replace('T', ' ').slice(11, 19) + ' CR';
  } catch {
    return dateStr;
  }
}

export async function runMonitorEvaluation(minutes: number = 20, isDetail: boolean = false): Promise<void> {
  console.log(`\n========================================================================`);
  console.log(`🎯 MONITOREO DE EVALUACIÓN DE SORTEOS Y TRÁFICO DE TERMINALES`);
  console.log(`⏰ Ventana analizada: últimos ${minutes} minutos`);
  console.log(`📡 Fuente: ClickHouse (Better Stack Logs - Producción)`);
  console.log(`========================================================================\n`);

  // 1. Ciclo de Vida de Evaluaciones de Sorteos
  const sorteosSql = `
    SELECT dt, raw 
    FROM remote(t563335_backend_bancas_logs) 
    WHERE dt >= now() - INTERVAL ${minutes} MINUTE 
      AND (
        raw ILIKE '%SORTEO_EVALUATE_DB%' 
        OR raw ILIKE '%SORTEO_EVALUATED_BROADCAST%'
        OR raw ILIKE '%SORTEO_EVALUATE_TRIGGERING_SYNC%'
        OR raw ILIKE '%SORTEO_EVALUATE_SYNC_COMPLETED%'
      )
    ORDER BY dt ASC FORMAT JSONEachRow
  `;

  // 2. Pre-calentamiento (Warmup) e Invalidación de Caché
  const cacheSql = `
    SELECT dt, raw 
    FROM remote(t563335_backend_bancas_logs) 
    WHERE dt >= now() - INTERVAL ${minutes} MINUTE 
      AND (
        raw ILIKE '%WARMUP_EVALUATED_SUMMARY%' 
        OR raw ILIKE '%WARMUP_BATCH%'
        OR raw ILIKE '%INVALIDATE_ACCOUNT_STATEMENT%' 
        OR raw ILIKE '%INVALIDATE_BY_SORTEO%'
        OR raw ILIKE '%CACHE_INVALIDATION%'
      )
    ORDER BY dt ASC FORMAT JSONEachRow
  `;

  // 3. Métricas Globales HTTP de evaluated-summary
  const httpGlobalSql = `
    SELECT 
      count() as total_requests,
      countIf(raw ILIKE '%"statusCode":200%') as status_200,
      countIf(raw ILIKE '%"statusCode":503%') as status_503,
      countIf(raw ILIKE '%"statusCode":500%') as status_500,
      countIf(toInt32OrZero(JSONExtractString(raw, 'message', 'responseTimeMS')) < 15) as hits_l1_sub15ms,
      countIf(toInt32OrZero(JSONExtractString(raw, 'message', 'responseTimeMS')) BETWEEN 15 AND 350) as hits_l2_sub350ms,
      countIf(toInt32OrZero(JSONExtractString(raw, 'message', 'responseTimeMS')) > 1000) as slow_over_1s,
      round(avg(toInt32OrZero(JSONExtractString(raw, 'message', 'responseTimeMS'))), 1) as avg_latency_ms,
      quantile(0.50)(toInt32OrZero(JSONExtractString(raw, 'message', 'responseTimeMS'))) as p50_ms,
      quantile(0.95)(toInt32OrZero(JSONExtractString(raw, 'message', 'responseTimeMS'))) as p95_ms,
      max(toInt32OrZero(JSONExtractString(raw, 'message', 'responseTimeMS'))) as max_latency_ms
    FROM remote(t563335_backend_bancas_logs) 
    WHERE dt >= now() - INTERVAL ${minutes} MINUTE 
      AND raw ILIKE '%evaluated-summary%'
      AND raw ILIKE '%http-request%'
    FORMAT JSONEachRow
  `;

  // 4. Desglose por IP de Terminales
  const httpByIpSql = `
    SELECT 
      JSONExtractString(raw, 'message', 'clientIP') as ip,
      count() as requests,
      min(toInt32OrZero(JSONExtractString(raw, 'message', 'responseTimeMS'))) as min_ms,
      round(avg(toInt32OrZero(JSONExtractString(raw, 'message', 'responseTimeMS'))), 1) as avg_ms,
      max(toInt32OrZero(JSONExtractString(raw, 'message', 'responseTimeMS'))) as max_ms
    FROM remote(t563335_backend_bancas_logs) 
    WHERE dt >= now() - INTERVAL ${minutes} MINUTE 
      AND raw ILIKE '%evaluated-summary%'
      AND raw ILIKE '%http-request%'
    GROUP BY ip
    ORDER BY requests DESC
    LIMIT 20
    FORMAT JSONEachRow
  `;

  // 5. Errores Críticos / 503 / Timeouts
  const errorsSql = `
    SELECT dt, raw 
    FROM remote(t563335_backend_bancas_logs) 
    WHERE dt >= now() - INTERVAL ${minutes} MINUTE 
      AND (
        raw ILIKE '%UNHANDLED_REJECTION%' 
        OR raw ILIKE '%POOL_TIMEOUT%' 
        OR raw ILIKE '%"statusCode":503%' 
        OR raw ILIKE '%"statusCode":500%'
        OR raw ILIKE '%LEVEL\\":50%'
      )
    ORDER BY dt DESC LIMIT 10 FORMAT JSONEachRow
  `;

  try {
    const [sorteos, cacheEvents, httpMetrics, terminals, errors] = await Promise.all([
      runQuery(sorteosSql),
      runQuery(cacheSql),
      runQuery(httpGlobalSql),
      runQuery(httpByIpSql),
      runQuery(errorsSql),
    ]);

    // 1. SORTEOS
    console.log(`📌 1. EVENTOS DE EVALUACIÓN DE SORTEO (${sorteos.length} eventos):`);
    if (sorteos.length === 0) {
      console.log('   (Ningún sorteo evaluado en este intervalo)');
    } else {
      for (const s of sorteos) {
        try {
          const parsed = typeof s.raw === 'string' ? JSON.parse(s.raw) : s.raw;
          const msg = parsed.message || parsed;
          const action = msg.action || 'EVENT';
          const payload = msg.payload || {};
          const timeCR = formatCRTime(s.dt);
          console.log(`   ⏱️  [${timeCR}] ${action}`);
          if (payload.sorteoId || payload.sorteoNombre || payload.winningNumber) {
            console.log(
              `      ↳ Sorteo: ${payload.sorteoNombre || payload.sorteoId} | Ganador: ${payload.winningNumber ?? 'N/A'}`
            );
          }
        } catch {
          console.log(`   - [${s.dt}] ${s.raw.slice(0, 150)}...`);
        }
      }
    }

    // 2. CACHÉ Y WARMUP
    console.log(`\n⚡ 2. SINCRONIZACIÓN CONTABLE Y PRE-CALENTAMIENTO (WARMUP):`);
    if (cacheEvents.length === 0) {
      console.log('   (Sin eventos de sincronización ni warmup en esta ventana)');
    } else {
      const warmups: any[] = [];
      const invalidations: any[] = [];
      for (const c of cacheEvents) {
        try {
          const parsed = typeof c.raw === 'string' ? JSON.parse(c.raw) : c.raw;
          const msg = parsed.message || parsed;
          const action = msg.action || 'CACHE';
          const payload = msg.payload || {};
          const timeCR = formatCRTime(c.dt);

          if (action.includes('WARMUP')) {
            warmups.push({ time: timeCR, action, payload });
          } else if (action.includes('INVALIDATE')) {
            invalidations.push({ time: timeCR, action, payload });
          }
        } catch {}
      }

      if (warmups.length > 0) {
        console.log(`   🔥 Warmups ejecutados (${warmups.length}):`);
        warmups.forEach((w) => {
          if (
            w.action === 'WARMUP_EVALUATED_SUMMARY_COMPLETED' ||
            w.action === 'WARMUP_BATCH_COMPLETED' ||
            w.action === 'WARMUP_EVALUATED_SUMMARY_FALLBACK_COMPLETED'
          ) {
            const isBatch = w.action === 'WARMUP_BATCH_COMPLETED';
            const statusIcon = isBatch ? '⚡' : w.payload.durationMs < 1000 ? '✅' : '⚠️';
            const extra = isBatch ? `(${w.payload.entriesCached} entries inyectadas en L1/L2)` : '';
            console.log(
              `      ${statusIcon} [${w.time}] ${w.action}: ${w.payload.totalVendors} vendedores pre-calentados en ${w.payload.durationMs} ms ${extra}`
            );
          } else {
            console.log(
              `      ℹ️  [${w.time}] ${w.action}: Sorteo ${w.payload.sorteoId?.slice(0, 8)}... (${w.payload.totalVendors} vendors)`
            );
          }
        });
      }

      if (invalidations.length > 0) {
        const sampleInv = invalidations[0];
        console.log(
          `   🧹 Invalidaciones de saldo: ${invalidations.length} eventos (Fecha auditada: ${sampleInv.payload?.date || 'N/A'})`
        );
        if (isDetail) {
          invalidations.slice(0, 5).forEach((inv) => {
            console.log(
              `      - [${inv.time}] ${inv.action} (Fecha: ${inv.payload?.date}, Vendedor: ${inv.payload?.vendedorId?.slice(0, 8)}...)`
            );
          });
        }
      }
    }

    // 3. MÉTRICAS GLOBALES HTTP
    console.log(`\n📊 3. RENDIMIENTO HTTP (evaluated-summary):`);
    if (httpMetrics.length > 0 && httpMetrics[0].total_requests > 0) {
      const m = httpMetrics[0];
      const p50 = Math.round(m.p50_ms || 0);
      const p95 = Math.round(m.p95_ms || 0);
      console.log(`   - Peticiones Totales:       ${m.total_requests}`);
      console.log(
        `   - HTTP 200 (Éxito):         ${m.status_200}  (${Math.round((m.status_200 / m.total_requests) * 100)}%)`
      );
      console.log(`   - HTTP 503 (Throttled):     ${m.status_503}  ${m.status_503 > 0 ? '❌ ATENCIÓN' : '✅ CERO'}`);
      console.log(`   - HTTP 500 (Errores Serv):  ${m.status_500}  ${m.status_500 > 0 ? '❌ ATENCIÓN' : '✅ CERO'}`);
      console.log(`   ---------------------------------------------`);
      console.log(`   - Latencia P50 (Mediana):   ${p50} ms`);
      console.log(`   - Latencia P95:             ${p95} ms`);
      console.log(`   - Latencia Promedio:        ${m.avg_latency_ms} ms`);
      console.log(`   - Latencia Máxima:          ${m.max_latency_ms} ms`);
      console.log(`   ---------------------------------------------`);
      console.log(
        `   - En Caché L1 RAM (<15ms):  ${m.hits_l1_sub15ms} requests (${Math.round((m.hits_l1_sub15ms / m.total_requests) * 100)}%)`
      );
      console.log(
        `   - En Caché L2 Upstash:      ${m.hits_l2_sub350ms} requests (${Math.round((m.hits_l2_sub350ms / m.total_requests) * 100)}%)`
      );
      console.log(`   - Peticiones Lentas (>1s):  ${m.slow_over_1s} requests`);
    } else {
      console.log('   (Sin peticiones a evaluated-summary en esta ventana)');
    }

    // 4. DESGLOSE POR TERMINAL
    if (terminals.length > 0) {
      console.log(`\n📱 4. ACTIVIDAD POR TERMINAL IP (Top ${terminals.length} terminales conectadas):`);
      console.log(`   IP TERMINAL       REQS   MIN (ms)   AVG (ms)   MAX (ms)   ESTADO CACHÉ`);
      console.log(`   ---------------------------------------------------------------------`);
      for (const t of terminals) {
        const ipFormatted = (t.ip || 'desconocida').padEnd(17);
        const reqsFormatted = String(t.requests).padStart(4);
        const minFormatted = String(t.min_ms).padStart(8);
        const avgFormatted = String(t.avg_ms).padStart(10);
        const maxFormatted = String(t.max_ms).padStart(10);
        const cacheIndicator =
          t.min_ms <= 15 ? '🟢 L1 Hit (<15ms)' : t.min_ms <= 350 ? '🔵 L2 Hit' : '🟡 Cold/DB';
        console.log(
          `   ${ipFormatted} ${reqsFormatted} ${minFormatted} ${avgFormatted} ${maxFormatted}   ${cacheIndicator}`
        );
      }
    }

    // 5. ERRORES
    console.log(`\n🚨 5. AUDITORÍA DE ERRORES Y ESTABILIDAD:`);
    const realErrors = errors.filter((e: any) => {
      return !e.raw.includes('SHUTDOWN_TIMEOUT') && !e.raw.includes('Connection is closed');
    });

    if (realErrors.length === 0) {
      console.log('   ✅ Sistema impecable: 0 errores 503, 0 timeouts de pool de base de datos, 0 rechazos.');
    } else {
      console.log(`   ⚠️ Se encontraron ${realErrors.length} eventos sospechosos:`);
      for (const e of realErrors.slice(0, 5)) {
        const timeCR = formatCRTime(e.dt);
        console.log(`   - [${timeCR}] ${e.raw.slice(0, 200)}...`);
      }
    }

    console.log(`\n========================================================================\n`);
  } catch (err: any) {
    console.error('Error ejecutando monitoreo:', err.message);
  }
}

// Ejecución autónoma si se invoca directamente desde CLI
if (require.main === module) {
  const cliArgs = process.argv.slice(2);
  const minutesArg = parseInt(cliArgs.find((a) => !a.startsWith('--')) || '20', 10);
  const detailArg = cliArgs.includes('--detail');
  runMonitorEvaluation(minutesArg, detailArg);
}
