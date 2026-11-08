import https from 'https';
import path from 'path';
import dotenv from 'dotenv';

// Prioridad: .env.local (desarrollo local), luego .env
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// ============================================================================
// Monitor de Evaluación de Sorteos y Tráfico de Terminales - Backend Bancas
// Multi-Tenant Edition
// ============================================================================
// Uso en Render Shell o Local:
//   npm run monitor -- 10
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
  console.log(`🎯 MONITOREO DE EVALUACIÓN MULTI-TENANT Y TRÁFICO DE TERMINALES`);
  console.log(`⏰ Ventana analizada: últimos ${minutes} minutos`);
  console.log(`📡 Fuente: ClickHouse (Better Stack Logs - Producción)`);
  console.log(`========================================================================\n`);

  // 1. Ciclo de Vida de Evaluaciones de Sorteos + Broadcasts
  const sorteosSql = `
    SELECT dt, raw 
    FROM remote(t563335_backend_bancas_logs) 
    WHERE dt >= now() - INTERVAL ${minutes} MINUTE 
      AND (
        raw ILIKE '%SORTEO_EVALUATE_DB%' 
        OR raw ILIKE '%SORTEO_EVALUATED_BROADCAST%'
        OR raw ILIKE '%SORTEO_EVALUATED_BROADCAST_ABORTED%'
        OR raw ILIKE '%SORTEO_EVALUATE_TRIGGERING_SYNC%'
        OR raw ILIKE '%SORTEO_EVALUATE_SYNC_COMPLETED%'
        OR raw ILIKE '%WARMUP_EVALUATED_SUMMARY%'
        OR raw ILIKE '%WARMUP_BATCH%'
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
      countIf(toInt32OrZero(JSONExtractString(raw, 'message', 'statusCode')) BETWEEN 200 AND 299) as status_2xx,
      countIf(toInt32OrZero(JSONExtractString(raw, 'message', 'statusCode')) = 200) as status_200,
      countIf(toInt32OrZero(JSONExtractString(raw, 'message', 'statusCode')) = 204) as status_204_cors,
      countIf(toInt32OrZero(JSONExtractString(raw, 'message', 'statusCode')) = 304) as status_304_cache,
      countIf(toInt32OrZero(JSONExtractString(raw, 'message', 'statusCode')) BETWEEN 400 AND 499) as status_4xx,
      countIf(toInt32OrZero(JSONExtractString(raw, 'message', 'statusCode')) = 503) as status_503,
      countIf(toInt32OrZero(JSONExtractString(raw, 'message', 'statusCode')) = 500) as status_500,
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
    LIMIT 15
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
        OR raw ILIKE '%SORTEO_EVALUATED_BROADCAST_ABORTED%'
      )
    ORDER BY dt DESC LIMIT 10 FORMAT JSONEachRow
  `;

  // 6. Peticiones Lentas Individuales (>1000ms)
  const slowRequestsSql = `
    SELECT 
      dt,
      JSONExtractString(raw, 'message', 'clientIP') as ip,
      JSONExtractString(raw, 'message', 'path') as path,
      toInt32OrZero(JSONExtractString(raw, 'message', 'statusCode')) as status_code,
      toInt32OrZero(JSONExtractString(raw, 'message', 'responseTimeMS')) as response_time_ms,
      JSONExtractString(raw, 'message', 'userId') as user_id,
      JSONExtractString(raw, 'message', 'bancaId') as banca_id
    FROM remote(t563335_backend_bancas_logs) 
    WHERE dt >= now() - INTERVAL ${minutes} MINUTE 
      AND raw ILIKE '%evaluated-summary%'
      AND raw ILIKE '%http-request%'
      AND toInt32OrZero(JSONExtractString(raw, 'message', 'responseTimeMS')) > 1000
    ORDER BY dt DESC
    LIMIT 20
    FORMAT JSONEachRow
  `;

  // 7. Tickets Lentos (>500ms) Desglosados
  const slowTicketsSql = `
    SELECT dt, raw
    FROM remote(t563335_backend_bancas_logs)
    WHERE dt >= now() - INTERVAL ${minutes} MINUTE
      AND raw ILIKE '%slow_ticket_breakdown%'
    ORDER BY dt DESC
    LIMIT 25
    FORMAT JSONEachRow
  `;

  // 8. Event Loop Lag & Pool Stats
  const eventLoopSql = `
    SELECT dt, raw
    FROM remote(t563335_backend_bancas_logs)
    WHERE dt >= now() - INTERVAL ${minutes} MINUTE
      AND raw ILIKE '%event_loop_lag%'
    ORDER BY dt DESC
    LIMIT 30
    FORMAT JSONEachRow
  `;

  // 9. Control de Crédito y Saldos en Vivo (/api/v1/credit/status/me)
  const creditMetricsSql = `
    SELECT 
      count() as total_requests,
      countIf(toInt32OrZero(JSONExtractString(raw, 'message', 'statusCode')) = 200) as status_200,
      countIf(toInt32OrZero(JSONExtractString(raw, 'message', 'statusCode')) = 401) as status_401,
      countIf(toInt32OrZero(JSONExtractString(raw, 'message', 'statusCode')) = 409) as status_409,
      countIf(toInt32OrZero(JSONExtractString(raw, 'message', 'statusCode')) BETWEEN 500 AND 599) as status_5xx,
      countIf(toInt32OrZero(JSONExtractString(raw, 'message', 'responseTimeMS')) <= 15) as hits_redis_sub15ms,
      countIf(toInt32OrZero(JSONExtractString(raw, 'message', 'responseTimeMS')) BETWEEN 16 AND 50) as hits_16_to_50ms,
      countIf(toInt32OrZero(JSONExtractString(raw, 'message', 'responseTimeMS')) > 100) as slow_over_100ms,
      round(avg(toInt32OrZero(JSONExtractString(raw, 'message', 'responseTimeMS'))), 1) as avg_latency_ms,
      quantile(0.50)(toInt32OrZero(JSONExtractString(raw, 'message', 'responseTimeMS'))) as p50_ms,
      quantile(0.95)(toInt32OrZero(JSONExtractString(raw, 'message', 'responseTimeMS'))) as p95_ms,
      max(toInt32OrZero(JSONExtractString(raw, 'message', 'responseTimeMS'))) as max_latency_ms
    FROM remote(t563335_backend_bancas_logs) 
    WHERE dt >= now() - INTERVAL ${minutes} MINUTE 
      AND raw ILIKE '%/api/v1/credit/status/me%'
      AND raw ILIKE '%http-request%'
    FORMAT JSONEachRow
  `;

  // 10. Eventos Críticos de Crédito
  const creditEventsSql = `
    SELECT 
      countIf(raw ILIKE '%CREDIT_STATUS_CHANGED%') as status_changed_events,
      countIf(raw ILIKE '%CREDIT_DEGRADED_MODE_ENTERED%') as degraded_entered_events,
      countIf(raw ILIKE '%ALERT_CREDIT_CHECK_FAIL_OPEN%') as fail_open_events,
      countIf(raw ILIKE '%GET_VENDOR_CREDIT_STATUS_REDIS_FIRST_WARN%') as redis_first_warns
    FROM remote(t563335_backend_bancas_logs) 
    WHERE dt >= now() - INTERVAL ${minutes} MINUTE 
      AND (
        raw ILIKE '%CREDIT_STATUS_CHANGED%' 
        OR raw ILIKE '%CREDIT_DEGRADED_MODE_ENTERED%' 
        OR raw ILIKE '%ALERT_CREDIT_CHECK_FAIL_OPEN%'
        OR raw ILIKE '%GET_VENDOR_CREDIT_STATUS_REDIS_FIRST_WARN%'
      )
    FORMAT JSONEachRow
  `;

  // 11. Peticiones Lentas de Crédito (>100ms) - para --detail
  const slowCreditSql = `
    SELECT 
      dt,
      JSONExtractString(raw, 'message', 'clientIP') as ip,
      toInt32OrZero(JSONExtractString(raw, 'message', 'statusCode')) as status_code,
      toInt32OrZero(JSONExtractString(raw, 'message', 'responseTimeMS')) as response_time_ms
    FROM remote(t563335_backend_bancas_logs) 
    WHERE dt >= now() - INTERVAL ${minutes} MINUTE 
      AND raw ILIKE '%/api/v1/credit/status/me%'
      AND raw ILIKE '%http-request%'
      AND toInt32OrZero(JSONExtractString(raw, 'message', 'responseTimeMS')) > 100
    ORDER BY dt DESC
    LIMIT 15
    FORMAT JSONEachRow
  `;

  // 12. Salud de Clientes Redis Segregados (Sales vs General)
  const redisHealthSql = `
    SELECT 
      countIf(JSONExtractString(raw, 'message', 'layer') = 'redis-sales' AND JSONExtractString(raw, 'message', 'action') = 'CIRCUIT_BREAKER_OPENED') as sales_cb_opened,
      countIf(JSONExtractString(raw, 'message', 'layer') = 'redis-sales' AND JSONExtractString(raw, 'message', 'action') = 'ERROR') as sales_errors,
      countIf(JSONExtractString(raw, 'message', 'layer') = 'redis-general' AND JSONExtractString(raw, 'message', 'action') = 'CIRCUIT_BREAKER_OPENED') as general_cb_opened,
      countIf(JSONExtractString(raw, 'message', 'layer') = 'redis-general' AND JSONExtractString(raw, 'message', 'action') = 'ERROR') as general_errors,
      countIf(raw ILIKE '%REDIS_COMMAND_TIMEOUT%') as redis_timeouts
    FROM remote(t563335_backend_bancas_logs) 
    WHERE dt >= now() - INTERVAL ${minutes} MINUTE 
    FORMAT JSONEachRow
  `;

  // 13. Workers de Renderizado Térmico (Segregación y Rendimiento)
  const workersSql = `
    SELECT 
      JSONExtractString(raw, 'message', 'payload', 'workerName') as worker,
      JSONExtractString(raw, 'message', 'payload', 'taskType') as type,
      count() as total_tasks,
      round(avg(toInt32OrZero(JSONExtractString(raw, 'message', 'payload', 'durationMs'))), 1) as avg_duration_ms,
      quantile(0.50)(toInt32OrZero(JSONExtractString(raw, 'message', 'payload', 'durationMs'))) as p50_ms,
      quantile(0.95)(toInt32OrZero(JSONExtractString(raw, 'message', 'payload', 'durationMs'))) as p95_ms,
      max(toInt32OrZero(JSONExtractString(raw, 'message', 'payload', 'durationMs'))) as max_duration_ms,
      max(toInt32OrZero(JSONExtractString(raw, 'message', 'payload', 'queueRemaining'))) as max_queue
    FROM remote(t563335_backend_bancas_logs)
    WHERE dt >= now() - INTERVAL ${minutes} MINUTE
      AND JSONExtractString(raw, 'message', 'action') = 'WORKER_TASK_SUCCESS'
    GROUP BY worker, type
    ORDER BY total_tasks DESC
    FORMAT JSONEachRow
  `;

  try {
    const [
      sorteos,
      cacheEvents,
      httpMetrics,
      terminals,
      errors,
      slowRequests,
      slowTickets,
      eventLoopLogs,
      creditMetrics,
      creditEvents,
      slowCredit,
      redisHealth,
      workers,
    ] = await Promise.all([
      runQuery(sorteosSql),
      runQuery(cacheSql),
      runQuery(httpGlobalSql),
      runQuery(httpByIpSql),
      runQuery(errorsSql),
      runQuery(slowRequestsSql),
      runQuery(slowTicketsSql),
      runQuery(eventLoopSql),
      runQuery(creditMetricsSql),
      runQuery(creditEventsSql),
      runQuery(slowCreditSql),
      runQuery(redisHealthSql),
      runQuery(workersSql),
    ]);

    // 1. SORTEOS AGRUPADOS Y AUDITORÍA DE SALAS SOCKET
    const sorteosMap = new Map<string, any>();
    for (const s of sorteos) {
      try {
        const parsed = typeof s.raw === 'string' ? JSON.parse(s.raw) : s.raw;
        const msg = parsed.message || parsed;
        const action = msg.action || 'EVENT';
        const payload = msg.payload || {};
        const sorteoId = payload.sorteoId;
        if (!sorteoId) continue;

        if (!sorteosMap.has(sorteoId)) {
          sorteosMap.set(sorteoId, {
            sorteoId,
            sorteoNombre: payload.sorteoNombre || null,
            winningNumber: payload.winningNumber || null,
            extraOutcomeCode: payload.extraOutcomeCode || null,
            bancaId: payload.bancaId || null,
            roomEmitted: null,
            dbTime: null,
            syncStartTime: null,
            syncEndTime: null,
            warmupStartTime: null,
            warmupEndTime: null,
            broadcastTime: null,
            totalVendors: null,
            entriesCached: null,
            warmupDurationMs: null,
            events: [] as any[],
          });
        }

        const item = sorteosMap.get(sorteoId);
        if (payload.bancaId && !item.bancaId) item.bancaId = payload.bancaId;
        if (payload.room && !item.roomEmitted) item.roomEmitted = payload.room;
        if (payload.sorteoNombre && !item.sorteoNombre) item.sorteoNombre = payload.sorteoNombre;
        if (payload.winningNumber && !item.winningNumber) item.winningNumber = payload.winningNumber;
        if (payload.extraOutcomeCode && !item.extraOutcomeCode) item.extraOutcomeCode = payload.extraOutcomeCode;
        if (payload.totalVendors || payload.entriesCached) {
          item.totalVendors = payload.totalVendors || payload.entriesCached;
          item.entriesCached = payload.entriesCached || payload.totalVendors;
        }

        const dateObj = new Date(s.dt.endsWith('Z') ? s.dt : s.dt + 'Z');
        item.events.push({ time: formatCRTime(s.dt), dtObj: dateObj, action, payload });

        if (action === 'SORTEO_EVALUATE_DB') item.dbTime = dateObj;
        else if (action === 'SORTEO_EVALUATE_TRIGGERING_SYNC') item.syncStartTime = dateObj;
        else if (action === 'SORTEO_EVALUATE_SYNC_COMPLETED') item.syncEndTime = dateObj;
        else if (action === 'WARMUP_EVALUATED_SUMMARY_START' || action === 'WARMUP_BATCH_START') {
          if (!item.warmupStartTime) item.warmupStartTime = dateObj;
        } else if (action === 'WARMUP_EVALUATED_SUMMARY_COMPLETED' || action === 'WARMUP_BATCH_COMPLETED') {
          item.warmupEndTime = dateObj;
          if (payload.durationMs) item.warmupDurationMs = payload.durationMs;
        } else if (action === 'SORTEO_EVALUATED_BROADCAST') {
          item.broadcastTime = dateObj;
          if (payload.room) item.roomEmitted = payload.room;
        }
      } catch {}
    }

    console.log(`📌 1. CICLO DE EVALUACIÓN Y BROADCAST (${sorteosMap.size} sorteos detectados):`);
    if (sorteosMap.size === 0) {
      console.log('   (Ningún ciclo de sorteo evaluado en esta ventana)');
    } else {
      for (const [id, s] of sorteosMap.entries()) {
        const totalCycleMs =
          s.dbTime && s.broadcastTime
            ? `${s.broadcastTime.getTime() - s.dbTime.getTime()} ms`
            : s.warmupDurationMs
            ? `${s.warmupDurationMs} ms (parcial)`
            : 'N/D';

        const syncDurationMs =
          s.syncStartTime && s.syncEndTime
            ? `${s.syncEndTime.getTime() - s.syncStartTime.getTime()} ms`
            : 'N/D';

        const warmupDurationText = s.warmupDurationMs
          ? `${s.warmupDurationMs} ms`
          : s.warmupStartTime && s.warmupEndTime
          ? `${s.warmupEndTime.getTime() - s.warmupStartTime.getTime()} ms`
          : 'N/D';

        const vendorsCount = s.totalVendors || s.entriesCached || 'N/A';
        const roomCheck = s.roomEmitted
          ? s.roomEmitted.startsWith('banca:')
            ? `🟢 ${s.roomEmitted} (Aislada)`
            : `🔴 ${s.roomEmitted} (GLOBAL!)`
          : '⏳ Esperando emisión...';

        console.log(
          `   🎰 Sorteo: ${s.sorteoNombre || id.slice(0, 8)} | Ganador: ${s.winningNumber ?? 'N/A'}${
            s.extraOutcomeCode ? ` (${s.extraOutcomeCode})` : ''
          }`
        );
        console.log(
          `      🏢 Banca ID:            ${s.bancaId ? s.bancaId.slice(0, 13) + '...' : 'Global / Desconocida'}`
        );
        console.log(`      📡 Sala WebSocket:       ${roomCheck}`);
        console.log(`      ⏱️  Ciclo Total:          ${totalCycleMs}`);
        console.log(`      ↳ Sincronización DB:    ${syncDurationMs}`);
        console.log(`      ↳ Warmup L1/L2:         ${warmupDurationText} (${vendorsCount} vendedores de esta banca)`);
        if (s.events.length > 0 && isDetail) {
          s.events.forEach((ev: any) => console.log(`        - [${ev.time}] ${ev.action}`));
        }
        console.log('');
      }
    }

    // 2. MÉTRICAS GLOBALES HTTP
    console.log(`📊 2. RENDIMIENTO GLOBAL HTTP (evaluated-summary):`);
    if (httpMetrics.length > 0 && httpMetrics[0].total_requests > 0) {
      const m = httpMetrics[0];
      const p50 = Math.round(m.p50_ms || 0);
      const p95 = Math.round(m.p95_ms || 0);
      const successfulReqs = Number(m.status_2xx || 0) + Number(m.status_304_cache || 0);
      const successPct = Math.round((successfulReqs / m.total_requests) * 100);

      console.log(`   - Peticiones Totales:       ${m.total_requests}`);
      console.log(`   - Peticiones Exitosas:      ${successfulReqs}  (${successPct}%)`);
      console.log(`   - HTTP 503 (Throttled):     ${m.status_503}  ${m.status_503 > 0 ? '❌ ATENCIÓN' : '✅ CERO'}`);
      console.log(`   - HTTP 500 (Errores Serv):  ${m.status_500}  ${m.status_500 > 0 ? '❌ ATENCIÓN' : '✅ CERO'}`);
      console.log(`   ---------------------------------------------`);
      console.log(`   - Latencia P50 (Mediana):   ${p50} ms`);
      console.log(`   - Latencia P95:             ${p95} ms`);
      console.log(`   - Latencia Promedio:        ${m.avg_latency_ms} ms`);
      console.log(`   - Latencia Máxima:          ${m.max_latency_ms} ms`);
      console.log(`   ---------------------------------------------`);
      console.log(
        `   - En Caché L1 RAM (<15ms):  ${m.hits_l1_sub15ms} reqs (${Math.round(
          (m.hits_l1_sub15ms / m.total_requests) * 100
        )}%)`
      );
      console.log(
        `   - En Caché L2 Redis Render: ${m.hits_l2_sub350ms} reqs (${Math.round(
          (m.hits_l2_sub350ms / m.total_requests) * 100
        )}%)`
      );
      console.log(`   - Peticiones Lentas (>1s):  ${m.slow_over_1s} reqs`);
    } else {
      console.log('   (Sin peticiones a evaluated-summary en esta ventana)');
    }

    // 3. DESGLOSE POR TERMINAL
    if (terminals.length > 0) {
      console.log(`\n📱 3. ACTIVIDAD POR TERMINAL IP (Top ${terminals.length}):`);
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

      if (isDetail && slowRequests.length > 0) {
        console.log(`\n   🔍 DESGLOSE INDIVIDUAL DE PETICIONES LENTAS (>1,000 ms):`);
        console.log(`   --------------------------------------------------------------------------------------------------------`);
        console.log(`   HORA CR      IP               STATUS   LATENCIA   BANCA          PATH`);
        console.log(`   --------------------------------------------------------------------------------------------------------`);
        for (const req of slowRequests) {
          const timeCR = formatCRTime(req.dt).padEnd(12);
          const ip = (req.ip || 'desconocida').padEnd(16);
          const status = String(req.status_code).padEnd(8);
          const lat = `${req.response_time_ms} ms`.padEnd(10);
          const banca = (req.banca_id ? req.banca_id.slice(0, 10) + '...' : 'N/A').padEnd(14);
          console.log(`   ${timeCR} ${ip} ${status} ${lat} ${banca} ${req.path}`);
        }
      }
    }

    // 4. ERRORES Y ESTABILIDAD
    console.log(`\n🚨 4. AUDITORÍA DE ERRORES Y ESTABILIDAD:`);
    const realErrors = errors.filter(
      (e: any) => !e.raw.includes('SHUTDOWN_TIMEOUT') && !e.raw.includes('Connection is closed')
    );

    if (realErrors.length === 0) {
      console.log('   ✅ Sistema impecable: 0 errores 503, 0 timeouts de DB, 0 broadcasts abortados.');
    } else {
      console.log(`   ⚠️ Se encontraron ${realErrors.length} eventos sospechosos:`);
      for (const e of realErrors.slice(0, 5)) {
        const timeCR = formatCRTime(e.dt);
        console.log(`   - [${timeCR}] ${e.raw.slice(0, 200)}...`);
      }
    }

    // 5. FAST-PATH DE VENTAS, EVENT LOOP Y POOLS
    console.log(`\n🏎️  5. FAST-PATH DE VENTAS, EVENT LOOP Y ESTADO DE POOLS:`);

    let maxP99 = 0;
    let maxLag = 0;
    let maxSalesWaitingSeen = 0;
    let maxGeneralWaitingSeen = 0;

    for (const el of eventLoopLogs) {
      try {
        const parsed = typeof el.raw === 'string' ? JSON.parse(el.raw) : el.raw;
        const msg = parsed.message || parsed;
        const p = msg.payload || {};
        if (p.p99_ms && p.p99_ms > maxP99) maxP99 = p.p99_ms;
        if (p.max_ms && p.max_ms > maxLag) maxLag = p.max_ms;
        const ps = p.pool_stats || {};
        if (ps.sales_max_waiting && ps.sales_max_waiting > maxSalesWaitingSeen)
          maxSalesWaitingSeen = ps.sales_max_waiting;
        if (ps.general_max_waiting && ps.general_max_waiting > maxGeneralWaitingSeen)
          maxGeneralWaitingSeen = ps.general_max_waiting;
      } catch {}
    }

    if (eventLoopLogs.length > 0) {
      const elStatus = maxP99 > 30 ? '⚠️ LAG ELEVADO' : '✅ FLUIDO';
      console.log(`   Event Loop: ${elStatus} (Max p99: ${maxP99} ms | Max lag: ${maxLag} ms)`);
      const poolStatus =
        maxSalesWaitingSeen > 0 || maxGeneralWaitingSeen > 0 ? '⚠️ COLA DETECTADA' : '✅ SIN COLAS';
      console.log(
        `   Pools:      ${poolStatus} (Max esperando Sales: ${maxSalesWaitingSeen} | General: ${maxGeneralWaitingSeen})`
      );
    } else {
      console.log('   ℹ️  Sin muestras de event_loop_lag en esta ventana.');
    }

    // Estado de Clientes Redis Segregados
    if (redisHealth && redisHealth.length > 0) {
      const rh = redisHealth[0];
      const salesStatus =
        rh.sales_cb_opened > 0
          ? '🚨 CB ABIERTO'
          : rh.sales_errors > 0
          ? '⚠️ ERRORES DETECTADOS'
          : '✅ 100% DISPONIBLE';
      const genStatus =
        rh.general_cb_opened > 0
          ? '⚠️ CB ABIERTO'
          : rh.general_errors > 0
          ? '⚠️ ERRORES DETECTADOS'
          : '✅ 100% DISPONIBLE';
      console.log(
        `   Redis Sales:   ${salesStatus} (Errores: ${rh.sales_errors || 0} | CB Abierto: ${rh.sales_cb_opened || 0})`
      );
      console.log(
        `   Redis General: ${genStatus} (Errores: ${rh.general_errors || 0} | CB Abierto: ${rh.general_cb_opened || 0})`
      );
      if (rh.redis_timeouts > 0) {
        console.log(`   Timeouts Redis:${rh.redis_timeouts} eventos detectados`);
      }
    }

    // Desglose de Tickets Lentos
    if (slowTickets.length === 0) {
      console.log('   ✅ Fast-Path impecable: 0 tickets emitidos con latencia > 500 ms.');
    } else {
      console.log(`   ⚠️ Se detectaron ${slowTickets.length} tickets lentos (> 500 ms):`);
      console.log(`   ---------------------------------------------------------------------------------------------------------------------------------------`);
      console.log(`   HORA CR      TICKET ID / #         TOTAL     PREFETCH   LOCK WAIT  LOCK ATT  POOL WAIT   TX (COMMIT)   POST     SALES WAIT/TOT`);
      console.log(`   ---------------------------------------------------------------------------------------------------------------------------------------`);
      for (const st of slowTickets) {
        try {
          const parsed = typeof st.raw === 'string' ? JSON.parse(st.raw) : st.raw;
          const msg = parsed.message || parsed;
          const p = msg.payload || {};
          const pb = p.prefetch_breakdown || {};
          const timeCR = formatCRTime(st.dt).padEnd(12);
          const tId = String(p.ticketNumber || (p.ticketId ? p.ticketId.slice(0, 10) + '...' : 'N/A')).padEnd(21);
          const total = `${p.t_total ?? 'N/A'} ms`.padEnd(10);
          const prefetch = `${p.t_prefetch ?? 0} ms`.padEnd(11);
          const lockWait = `${pb.lock_wait_ms !== undefined ? pb.lock_wait_ms : '-'} ms`.padEnd(11);
          const lockAtt = String(pb.lock_attempts !== undefined ? pb.lock_attempts : '-').padEnd(10);
          const poolWait = `${p.t_pool_wait ?? 0} ms`.padEnd(12);
          const tx = `${p.t_tx ?? 0} ms`.padEnd(14);
          const post = `${p.t_post ?? 0} ms`.padEnd(9);
          const poolInfo = `${p.sales_pool_waiting ?? 0}/${p.sales_pool_total ?? 0}`;
          console.log(`   ${timeCR} ${tId} ${total} ${prefetch} ${lockWait} ${lockAtt}${poolWait} ${tx} ${post}${poolInfo}`);
          if (isDetail || Object.keys(pb).length > 0) {
            const parts = [];
            if (pb.t_actor !== undefined) parts.push(`Actor: ${pb.t_actor}ms`);
            if (pb.t_resolved_ventana !== undefined) parts.push(`Ventana: ${pb.t_resolved_ventana}ms`);
            if (pb.t_cutoff !== undefined) parts.push(`Cutoff: ${pb.t_cutoff}ms`);
            if (pb.t_rules !== undefined) parts.push(`Rules: ${pb.t_rules}ms`);
            if (pb.t_risk_prefetch !== undefined) parts.push(`Risk: ${pb.t_risk_prefetch}ms`);
            if (pb.t_lock_acquire !== undefined) parts.push(`LockAcq: ${pb.t_lock_acquire}ms`);
            if (pb.t_credit !== undefined) parts.push(`Crédito: ${pb.t_credit}ms`);
            if (pb.t_multipliers !== undefined) parts.push(`Mults: ${pb.t_multipliers}ms`);
            if (parts.length > 0) {
              console.log(`      └─ Prefetch Detalle: ${parts.join(' | ')}`);
            }
          }
        } catch {}
      }
    }

    // 6. CONTROL DE CRÉDITO Y SALDOS EN VIVO (/status/me)
    console.log(`\n💳 6. CONTROL DE CRÉDITO Y SALDOS EN VIVO (/status/me):`);
    if (creditMetrics.length > 0 && creditMetrics[0].total_requests > 0) {
      const cm = creditMetrics[0];
      const ce = creditEvents.length > 0 ? creditEvents[0] : {};
      const rpm = (cm.total_requests / minutes).toFixed(1);
      const redisFirstPct = Math.round((cm.hits_redis_sub15ms / cm.total_requests) * 100);
      const p50 = Math.round(cm.p50_ms || 0);
      const p95 = Math.round(cm.p95_ms || 0);
      const degradedStatus =
        ce.degraded_entered_events > 0
          ? `⚠️ DEGRADADO REGISTRADO (${ce.degraded_entered_events} eventos)`
          : '✅ NORMAL (Redis 100% operativo)';

      console.log(`   - Peticiones Totales:       ${cm.total_requests}  (~${rpm} req/min)`);
      console.log(`   - Tasa Redis-First (RAM):   ${cm.hits_redis_sub15ms} reqs  (${redisFirstPct}%) ⚡ (<15 ms)`);
      console.log(`   - Latencia P50 (Mediana):   ${p50} ms`);
      console.log(`   - Latencia P95:             ${p95} ms`);
      console.log(`   - Latencia Promedio:        ${cm.avg_latency_ms} ms (Máx: ${cm.max_latency_ms} ms)`);
      console.log(`   ---------------------------------------------`);
      console.log(`   - Sesiones Expiradas (401): ${cm.status_401} reqs`);
      console.log(`   - Errores de Servidor (5xx):${cm.status_5xx}  ${cm.status_5xx > 0 ? '❌ ATENCIÓN' : '✅ CERO'}`);
      console.log(
        `   - Bloqueos de Venta (409):  ${cm.status_409}  ${cm.status_409 > 0 ? '⚠️ LÍMITE EXCEDIDO' : '✅ CERO'}`
      );
      console.log(`   - Modo Degradado / Fallback:${degradedStatus}`);

      if (isDetail && slowCredit.length > 0) {
        console.log(`\n   🔍 DESGLOSE INDIVIDUAL DE /status/me LENTOS (>100 ms):`);
        console.log(`   ---------------------------------------------------------------------`);
        console.log(`   HORA CR      IP               STATUS   LATENCIA`);
        console.log(`   ---------------------------------------------------------------------`);
        for (const req of slowCredit) {
          const timeCR = formatCRTime(req.dt).padEnd(12);
          const ip = (req.ip || 'desconocida').padEnd(16);
          const status = String(req.status_code).padEnd(8);
          const lat = `${req.response_time_ms} ms`.padEnd(10);
          console.log(`   ${timeCR} ${ip} ${status} ${lat}`);
        }
      }
    } else {
      console.log('   (Sin peticiones a /credit/status/me en esta ventana)');
    }

    // 7. WORKERS DE RENDERIZADO Y TÉRMICO (Segregación y Rendimiento)
    if (workers && workers.length > 0) {
      console.log(`\n🖨️  7. WORKERS DE RENDERIZADO TÉRMICO Y PROCESAMIENTO GRÁFICO:`);
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
