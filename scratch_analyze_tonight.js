const https = require('https');

function queryBetterStack(sql) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'eu-fsn-3-connect.betterstackdata.com',
      port: 443,
      path: '/',
      method: 'POST',
      auth: 'uU1EYcbZhqwNJFteumO55IPD5B02j2dSP:blu9rYvWzd63lsK3ZGUYxDkdyxW2jyjrbUbIxty2iQbW5nEk2vyZ5Cz4g5yulNUC',
      headers: {
        'Content-Type': 'text/plain',
        'Content-Length': Buffer.byteLength(sql)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          const lines = data.trim().split('\n').filter(Boolean).map(l => {
            try { return JSON.parse(l); } catch (e) { return l; }
          });
          resolve(lines);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(sql);
    req.end();
  });
}

async function run() {
  console.log("==================================================================");
  console.log(" LECTURAS DE TELEMETRÍA Y LOGS: 19:25 CR a 21:38 CR (20/08/2026)");
  console.log(" (Ventana UTC: 2026-08-21 01:25:00 a 2026-08-21 03:40:00)");
  console.log("==================================================================\n");

  // 1. Total Requests / Logs
  const total = await queryBetterStack(`
    SELECT count() as totalLogs
    FROM remote(t563335_backend_bancas_logs)
    WHERE dt >= '2026-08-21 01:25:00' AND dt <= '2026-08-21 03:40:00'
    FORMAT JSONEachRow
  `);
  console.log("Total de logs en el periodo:", total[0]);

  // 2. HTTP Status Code distribution
  const httpCodes = await queryBetterStack(`
    SELECT 
      JSONExtractInt(raw, 'payload', 'statusCode') as statusCode,
      count() as count
    FROM remote(t563335_backend_bancas_logs)
    WHERE dt >= '2026-08-21 01:25:00' AND dt <= '2026-08-21 03:40:00'
      AND raw ILIKE '%HTTP_REQUEST_COMPLETED%'
    GROUP BY statusCode
    ORDER BY count DESC
    FORMAT JSONEachRow
  `);
  console.log("\nDistribucción de Códigos HTTP:");
  console.table(httpCodes);

  // 3. Worker operations (PDF_TO_PNG vs GENERATE_TICKET)
  const workerEvents = await queryBetterStack(`
    SELECT 
      toStartOfInterval(dt, INTERVAL 10 MINUTE) as intervalUTC,
      countIf(raw ILIKE '%PDF_TO_PNG%' OR raw ILIKE '%TICKET_NUMBERS_SUMMARY_CONVERTING_TO_PNG%') as pdfToPngCount,
      countIf(raw ILIKE '%TICKET_IMAGE_GENERATED%' OR raw ILIKE '%TICKET_IMAGE%') as ticketImageCount,
      countIf(raw ILIKE '%EVALUATING_SORTEO%' OR raw ILIKE '%SORTEO_EVALUATED%') as sorteoEvaluatedCount
    FROM remote(t563335_backend_bancas_logs)
    WHERE dt >= '2026-08-21 01:25:00' AND dt <= '2026-08-21 03:40:00'
    GROUP BY intervalUTC
    ORDER BY intervalUTC ASC
    FORMAT JSONEachRow
  `);
  console.log("\nOperaciones por Intervalos de 10 min (Hora UTC / CR):");
  const formattedEvents = workerEvents.map(e => {
    const utcDate = new Date(e.intervalUTC + "Z");
    const crHour = new Date(utcDate.getTime() - 6 * 3600 * 1000).toISOString().slice(11, 16);
    return {
      horaCR: crHour,
      pdfToPng: e.pdfToPngCount,
      ticketImages: e.ticketImageCount,
      sorteoEvals: e.sorteoEvaluatedCount
    };
  });
  console.table(formattedEvents);

  // 4. Memory readings / Telemetry
  const memoryLogs = await queryBetterStack(`
    SELECT 
      dt,
      JSONExtractInt(raw, 'payload', 'heapUsedMB') as heapUsedMB,
      JSONExtractInt(raw, 'payload', 'rssMB') as rssMB,
      JSONExtractString(raw, 'action') as action
    FROM remote(t563335_backend_bancas_logs)
    WHERE dt >= '2026-08-21 01:25:00' AND dt <= '2026-08-21 03:40:00'
      AND (raw ILIKE '%heap%' OR raw ILIKE '%TELEMETRY%' OR raw ILIKE '%MEMORY%')
    ORDER BY dt DESC
    LIMIT 15
    FORMAT JSONEachRow
  `);
  console.log("\nLecturas de memoria en logs:");
  console.log(memoryLogs);

  // 5. Errores reales (5xx)
  const errors5xx = await queryBetterStack(`
    SELECT 
      dt,
      JSONExtractString(raw, 'action') as action,
      JSONExtractString(raw, 'msg') as msg,
      raw
    FROM remote(t563335_backend_bancas_logs)
    WHERE dt >= '2026-08-21 01:25:00' AND dt <= '2026-08-21 03:40:00'
      AND (
        JSONExtractInt(raw, 'payload', 'statusCode') >= 500
        OR JSONExtractString(raw, 'level') IN ('error', '50')
      )
    ORDER BY dt DESC
    LIMIT 10
    FORMAT JSONEachRow
  `);
  console.log("\nErrores 5xx o nivel error:", errors5xx.length === 0 ? "¡CERO ERRORES 5xx!" : errors5xx);
}

run().catch(console.error);
