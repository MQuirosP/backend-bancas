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
  const auth = process.env.BETTERSTACK_CLICKHOUSE_AUTH;
  if (!auth) {
    throw new Error(
      'Falta la variable de entorno BETTERSTACK_CLICKHOUSE_AUTH (formato "usuario:password") para consultar métricas.'
    );
  }

  return new Promise((resolve, reject) => {
    const options = {
      hostname: process.env.BETTERSTACK_CLICKHOUSE_HOST || 'us-west-2a-connect.betterstackdata.com',
      port: 443,
      path: '/',
      method: 'POST',
      auth,
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
    FROM remote(t604487_backend_bancas_logs) 
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
    FROM remote(t604487_backend_bancas_logs) 
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
    FROM remote(t604487_backend_bancas_logs) 
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
    FROM remote(t604487_backend_bancas_logs) 
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
    FROM remote(t604487_backend_bancas_logs) 
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

  // 6. Métricas de Workers Segregados (Tickets vs PDFs)
  const workersSql = `
    SELECT 
      if(JSONExtractString(raw, 'message', 'payload', 'workerName') != '', JSONExtractString(raw, 'message', 'payload', 'workerName'), 'legacy-shared') as worker,
      JSONExtractString(raw, 'message', 'payload', 'type') as type,
      count() as total_tasks,
      round(avg(toInt32OrZero(JSONExtractString(raw, 'message', 'payload', 'durationMs'))), 1) as avg_duration_ms,
      quantile(0.50)(toInt32OrZero(JSONExtractString(raw, 'message', 'payload', 'durationMs'))) as p50_ms,
      quantile(0.95)(toInt32OrZero(JSONExtractString(raw, 'message', 'payload', 'durationMs'))) as p95_ms,
      max(toInt32OrZero(JSONExtractString(raw, 'message', 'payload', 'durationMs'))) as max_duration_ms,
      max(toInt32OrZero(JSONExtractString(raw, 'message', 'payload', 'queueRemaining'))) as max_queue
    FROM remote(t604487_backend_bancas_logs)
    WHERE dt >= now() - INTERVAL ${minutes} MINUTE
      AND JSONExtractString(raw, 'message', 'action') = 'WORKER_TASK_SUCCESS'
    GROUP BY worker, type
    ORDER BY total_tasks DESC
    FORMAT JSONEachRow
  `;

  // 7. Desglose de Caché de Imágenes Térmicas (/image)
  const imageRenderCacheSql = `
    SELECT 
      JSONExtractString(raw, 'message', 'action') as action,
      count() as count
    FROM remote(t604487_backend_bancas_logs)
    WHERE dt >= now() - INTERVAL ${minutes} MINUTE
      AND JSONExtractString(raw, 'message', 'action') IN ('TICKET_IMAGE_CACHE_HIT', 'TICKET_IMAGE_GENERATED')
    GROUP BY action
    FORMAT JSONEachRow
  `;

  // 8. Eventos de Ciclo de Vida y Warmup de Workers
  const workerLifecycleSql = `
    SELECT 
      dt,
      JSONExtractString(raw, 'message', 'action') as action,
      JSONExtractString(raw, 'message', 'payload', 'workerName') as worker,
      JSONExtractString(raw, 'message', 'payload', 'durationMs') as durationMs,
      raw
    FROM remote(t604487_backend_bancas_logs)
    WHERE dt >= now() - INTERVAL ${minutes} MINUTE
      AND (
        raw ILIKE '%WORKER_WARMUP%' 
        OR raw ILIKE '%WORKER_INIT_PERSISTENT%' 
        OR raw ILIKE '%WORKER_FATAL_ERROR%' 
        OR raw ILIKE '%IMAGE_CONVERSION_WORKER_ERROR%'
        OR raw ILIKE '%WORKER_EXITED_UNEXPECTEDLY%'
      )
    ORDER BY dt DESC
    LIMIT 10
    FORMAT JSONEachRow
  `;

  try {
    const [sorteos, cacheEvents, httpMetrics, terminals, errors, workers, imageCache, workerLifecycle] = await Promise.all([
      runQuery(sorteosSql),
      runQuery(cacheSql),
      runQuery(httpGlobalSql),
      runQuery(httpByIpSql),
      runQuery(errorsSql),
      runQuery(workersSql),
      runQuery(imageRenderCacheSql),
      runQuery(workerLifecycleSql),
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

    // 6. WORKERS DE RENDERIZADO Y TÉRMICO (Segregación y Rendimiento)
    console.log(`\n🖨️ 6. WORKERS DE RENDERIZADO TÉRMICO Y PROCESAMIENTO GRÁFICO:`);
    
    // A. Desglose de Caché de Imágenes de Tickets
    const hitRow = imageCache.find((c: any) => c.action === 'TICKET_IMAGE_CACHE_HIT');
    const genRow = imageCache.find((c: any) => c.action === 'TICKET_IMAGE_GENERATED');
    const hits = hitRow ? Number(hitRow.count) : 0;
    const generated = genRow ? Number(genRow.count) : 0;
    const totalImageRequests = hits + generated;
    const hitRate = totalImageRequests > 0 ? Math.round((hits / totalImageRequests) * 100) : 0;

    console.log(`   📦 Caché Determinista de Imágenes (/image):`);
    console.log(`      - Solicitudes Totales:        ${totalImageRequests}`);
    console.log(`      - Cache Hits en Redis (<5ms): ${hits} (${hitRate}%) ${hitRate >= 50 ? '🟢 ÓPTIMO' : '🔵 EN CRECIMIENTO'}`);
    console.log(`      - Generados por Worker:       ${generated}`);

    // B. Rendimiento por Worker Runner
    console.log(`\n   🧵 Desempeño por Worker Runner (Segregado):`);
    if (workers.length === 0) {
      console.log('      (Sin tareas de workers ejecutadas en este intervalo)');
    } else {
      console.log(`      WORKER RUNNER     TAREA            TOTAL   AVG (ms)   P50 (ms)   P95 (ms)   MAX (ms)   MAX COLA`);
      console.log(`      -----------------------------------------------------------------------------------------------`);
      for (const w of workers) {
        const workerName = String(w.worker || 'shared').padEnd(17);
        const taskType = String(w.type || 'TASK').padEnd(16);
        const totalTasks = String(w.total_tasks).padStart(5);
        const avgMs = String(w.avg_duration_ms).padStart(10);
        const p50Ms = String(w.p50_ms || 0).padStart(10);
        const p95Ms = String(w.p95_ms || 0).padStart(10);
        const maxMs = String(w.max_duration_ms).padStart(10);
        const maxQueue = String(w.max_queue).padStart(10);
        console.log(`      ${workerName} ${taskType} ${totalTasks} ${avgMs} ${p50Ms} ${p95Ms} ${maxMs} ${maxQueue}`);
      }
    }

    // C. Ciclo de Vida y Warmup
    const warmups = workerLifecycle.filter((l: any) => l.action.includes('WARMUP'));
    const workerErrors = workerLifecycle.filter((l: any) => l.action.includes('ERROR') || l.action.includes('EXITED'));
    if (warmups.length > 0) {
      console.log(`\n   🔥 Eventos de Precalentamiento (Warmup):`);
      for (const wu of warmups) {
        const timeCR = formatCRTime(wu.dt);
        console.log(`      - [${timeCR}] ${wu.action} (duración: ${wu.durationMs || 'N/A'} ms)`);
      }
    }
    if (workerErrors.length > 0) {
      console.log(`\n   ⚠️ Eventos Inusuales en Workers:`);
      for (const we of workerErrors) {
        const timeCR = formatCRTime(we.dt);
        console.log(`      - [${timeCR}] ${we.action} en [${we.worker || 'desconocido'}]: ${we.raw.slice(0, 150)}...`);
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
