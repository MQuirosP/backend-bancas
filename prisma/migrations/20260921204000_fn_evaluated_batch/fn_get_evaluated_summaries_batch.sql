CREATE OR REPLACE FUNCTION fn_get_evaluated_summaries_batch(
  p_sorteo_id UUID,
  p_banca_id  UUID
)
RETURNS TABLE (
  user_id               UUID,
  summary_only_payload  JSONB,
  full_payload          JSONB,
  initial_accumulated   NUMERIC
)
LANGUAGE sql
STABLE
AS $$
WITH

-- 1. Fecha de negocio CR y límites SARGables de mes
sorteo_date AS (
  SELECT
    ((s."scheduledAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Costa_Rica')::date AS biz_date,
    date_trunc('month', ((s."scheduledAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Costa_Rica'))::date AS month_start,
    (date_trunc('month', ((s."scheduledAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Costa_Rica')) + INTERVAL '1 month')::date AS next_month_start
  FROM "Sorteo" s
  WHERE s.id = p_sorteo_id
),

-- 2. Vendedores activos de la banca (directos o via ventana) + safety net RCD
vendors AS (
  SELECT u.id
  FROM "User" u
  WHERE u.role = 'VENDEDOR'::"Role"
    AND u."isActive" = true
    AND u."deletedAt" IS NULL
    AND (
      u."bancaId" = p_banca_id
      OR u."ventanaId" IN (
        SELECT v.id FROM "Ventana" v
        WHERE v."bancaId" = p_banca_id
          AND v."deletedAt" IS NULL
      )
    )

  UNION

  SELECT DISTINCT rcd."vendedorId"
  FROM "ResumenCierreDiario" rcd
  WHERE rcd."sorteoId" = p_sorteo_id
),

-- 3. Totales del dia desde AccountStatement
day_stmt AS (
  SELECT
    ast."vendedorId",
    COALESCE(ast."totalSales",         0) AS total_sales,
    COALESCE(ast."vendedorCommission", 0) AS total_commission,
    COALESCE(ast."totalPayouts",       0) AS total_prizes,
    COALESCE(ast."ticketCount",        0) AS total_tickets,
    COALESCE(ast."totalPaid",          0) AS total_paid,
    COALESCE(ast."totalCollected",     0) AS total_collected,
    COALESCE(ast."balance",            0) AS day_balance,
    COALESCE(
      NULLIF(ast."remainingBalance", 0),
      ast."accumulatedBalance",
      0
    ) AS accumulated
  FROM "AccountStatement" ast
  CROSS JOIN sorteo_date sd
  WHERE ast."vendedorId" IN (SELECT id FROM vendors)
    AND ast.date = sd.biz_date
),

-- 4. Saldo del dia anterior para postproceso de accumulated
prev_day_stmt AS (
  SELECT
    ast."vendedorId",
    COALESCE(
      NULLIF(ast."remainingBalance", 0),
      ast."accumulatedBalance",
      0
    ) AS prev_accumulated
  FROM "AccountStatement" ast
  CROSS JOIN sorteo_date sd
  WHERE ast."vendedorId" IN (SELECT id FROM vendors)
    AND ast.date = sd.biz_date - INTERVAL '1 day'
),

-- 5. Comisiones por tipo + rcd_tickets + total_sorteos del dia
day_rcd AS (
  SELECT
    rcd."vendedorId",
    COALESCE(SUM(CASE WHEN rcd.tipo = 'NUMERO'::"BetType"
                      THEN rcd."comisionVendedor" ELSE 0 END), 0) AS comm_num,
    COALESCE(SUM(CASE WHEN rcd.tipo = 'REVENTADO'::"BetType"
                      THEN rcd."comisionVendedor" ELSE 0 END), 0) AS comm_rev,
    COALESCE(SUM(rcd."ticketsCount"), 0)::int  AS rcd_tickets,
    COUNT(DISTINCT rcd."sorteoId")             AS total_sorteos
  FROM "ResumenCierreDiario" rcd
  CROSS JOIN sorteo_date sd
  WHERE rcd."vendedorId" IN (SELECT id FROM vendors)
    AND rcd."businessDate" = sd.biz_date
  GROUP BY rcd."vendedorId"
),

-- 6. Totales mensuales usando rangos SARGables (aprovecha índice businessDate)
month_rcd AS (
  SELECT
    rcd."vendedorId",
    COALESCE(SUM(rcd."totalVendida"),     0) AS m_sales,
    COALESCE(SUM(rcd."comisionVendedor"), 0) AS m_commission,
    COALESCE(SUM(CASE WHEN rcd.tipo = 'NUMERO'::"BetType"
                      THEN rcd."comisionVendedor" ELSE 0 END), 0) AS m_comm_num,
    COALESCE(SUM(CASE WHEN rcd.tipo = 'REVENTADO'::"BetType"
                      THEN rcd."comisionVendedor" ELSE 0 END), 0) AS m_comm_rev,
    COALESCE(SUM(rcd.ganado),             0) AS m_prizes,
    COALESCE(SUM(rcd."ticketsCount"),     0) AS m_tickets
  FROM "ResumenCierreDiario" rcd
  CROSS JOIN sorteo_date sd
  WHERE rcd."vendedorId" IN (SELECT id FROM vendors)
    AND rcd."businessDate" >= sd.month_start
    AND rcd."businessDate" <  sd.next_month_start
  GROUP BY rcd."vendedorId"
),

-- 7. Balance del mes anterior directo por vendedor (evita scan de 12,500 filas)
prev_month_balance AS (
  SELECT DISTINCT ON (ast."vendedorId")
    ast."vendedorId",
    COALESCE(
      NULLIF(ast."remainingBalance", 0),
      ast."accumulatedBalance",
      0
    ) AS prev_balance
  FROM vendors v
  CROSS JOIN sorteo_date sd
  JOIN "AccountStatement" ast ON ast."vendedorId" = v.id
  WHERE ast.date < sd.month_start
  ORDER BY ast."vendedorId", ast.date DESC
),

-- 8. Pagos y cobros del mes con rangos indexables
month_payments AS (
  SELECT
    ap."vendedorId",
    COALESCE(SUM(CASE WHEN ap.type = 'payment'
                      THEN ap.amount ELSE 0 END), 0) AS m_paid,
    COALESCE(SUM(CASE WHEN ap.type = 'collection'
                      THEN ap.amount ELSE 0 END), 0) AS m_collected
  FROM "AccountPayment" ap
  CROSS JOIN sorteo_date sd
  WHERE ap."vendedorId" IN (SELECT id FROM vendors)
    AND ap."isReversed" = false
    AND ap.date >= sd.month_start
    AND ap.date <  sd.next_month_start
  GROUP BY ap."vendedorId"
),

-- 9. Sorteos evaluados del dia
day_sorteos AS (
  SELECT
    rcd."vendedorId",
    s.id                                          AS sorteo_id,
    s.name                                        AS sorteo_name,
    s."scheduledAt",
    s."loteriaId",
    s."extraMultiplierId",
    s."extraMultiplierX",
    s."winningNumber",
    l.name                                        AS loteria_name,
    COALESCE(SUM(rcd."totalVendida"),   0)        AS s_sales,
    COALESCE(SUM(rcd."comisionTotal"),  0)        AS s_commission_total,
    COALESCE(SUM(rcd.ganado),           0)        AS s_prizes,
    COALESCE(SUM(rcd."ticketsCount"),   0)::int   AS s_tickets
  FROM "ResumenCierreDiario" rcd
  JOIN "Sorteo"  s ON rcd."sorteoId" = s.id
  JOIN "Loteria" l ON s."loteriaId"  = l.id
  CROSS JOIN sorteo_date sd
  WHERE s.status = 'EVALUATED'::"SorteoStatus"
    AND (s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')::date = sd.biz_date
    AND rcd."vendedorId" IN (SELECT id FROM vendors)
  GROUP BY
    rcd."vendedorId", s.id, s.name, s."scheduledAt",
    s."loteriaId", s."extraMultiplierId", s."extraMultiplierX",
    s."winningNumber", l.name
),

-- 10. RSM con fusion COALESCE
rsm_data AS (
  SELECT
    rsm."vendedorId",
    rsm."sorteoId",
    COALESCE(rsm."multiplierId", s."extraMultiplierId") AS resolved_mult_id,
    SUM(rsm."totalSales")               AS m_sales,
    SUM(rsm."totalCommission")         AS m_commission,
    SUM(rsm."commissionByNumber")       AS m_comm_num,
    SUM(rsm."commissionByReventado")   AS m_comm_rev,
    SUM(rsm."totalPrizes")             AS m_prizes,
    SUM(rsm."ticketCount")::int        AS m_tickets,
    SUM(rsm."winningTicketsCount")::int AS m_winning,
    SUM(rsm."paidTicketsCount")::int   AS m_paid_t
  FROM "ResumenSorteoMultiplicador" rsm
  JOIN "Sorteo" s ON rsm."sorteoId" = s.id
  WHERE rsm."vendedorId" IN (SELECT id FROM vendors)
    AND rsm."sorteoId" IN (SELECT DISTINCT sorteo_id FROM day_sorteos)
  GROUP BY
    rsm."vendedorId", rsm."sorteoId",
    COALESCE(rsm."multiplierId", s."extraMultiplierId")
),

-- 11. Agregados por (vendedor, sorteo)
rsm_per_sorteo AS (
  SELECT
    "vendedorId",
    "sorteoId",
    SUM(m_commission)::numeric AS vendor_commission,
    SUM(m_comm_num)::numeric   AS comm_num,
    SUM(m_comm_rev)::numeric   AS comm_rev,
    SUM(m_winning)::int        AS winning_count,
    SUM(m_paid_t)::int         AS paid_count
  FROM rsm_data
  GROUP BY "vendedorId", "sorteoId"
),

-- 12. byMultiplier[] JSONB
by_mult AS (
  SELECT
    rd."vendedorId",
    rd."sorteoId",
    jsonb_agg(
      jsonb_build_object(
        'multiplierId',           lm.id::text,
        'multiplierName',         lm.name,
        'multiplierValue',        lm."valueX",
        'totalSales',             rd.m_sales,
        'totalCommission',        rd.m_commission,
        'commissionByNumber',     rd.m_comm_num,
        'commissionByReventado',  rd.m_comm_rev,
        'totalPrizes',            rd.m_prizes,
        'ticketCount',            rd.m_tickets,
        'subtotal',               rd.m_sales - rd.m_commission - rd.m_prizes,
        'winningTicketsCount',    rd.m_winning,
        'paidTicketsCount',       rd.m_paid_t,
        'unpaidTicketsCount',     rd.m_winning - rd.m_paid_t
      )
      ORDER BY lm."valueX" ASC
    ) AS by_multiplier_json
  FROM rsm_data rd
  JOIN "LoteriaMultiplier" lm ON lm.id = rd.resolved_mult_id
  GROUP BY rd."vendedorId", rd."sorteoId"
),

-- 13. Items de sorteo JSONB
sorteo_items AS (
  SELECT
    ds."vendedorId",
    ds."scheduledAt",
    jsonb_build_object(
      'sorteoId',    ds.sorteo_id::text,
      'sorteoName',  ds.sorteo_name,
      'scheduledAt', to_char(ds."scheduledAt" AT TIME ZONE 'America/Costa_Rica',
                             'YYYY-MM-DD"T"HH24:MI:SS'),
      'date',        to_char(ds."scheduledAt" AT TIME ZONE 'America/Costa_Rica',
                             'YYYY-MM-DD'),
      'time', (
        CASE
          WHEN EXTRACT(HOUR FROM (ds."scheduledAt" AT TIME ZONE 'America/Costa_Rica'))::int = 0
            THEN '12'
          WHEN EXTRACT(HOUR FROM (ds."scheduledAt" AT TIME ZONE 'America/Costa_Rica'))::int > 12
            THEN ((EXTRACT(HOUR FROM (ds."scheduledAt" AT TIME ZONE 'America/Costa_Rica'))::int) - 12)::text
          ELSE (EXTRACT(HOUR FROM (ds."scheduledAt" AT TIME ZONE 'America/Costa_Rica'))::int)::text
        END
        || ':'
        || LPAD(
             (EXTRACT(MINUTE FROM (ds."scheduledAt" AT TIME ZONE 'America/Costa_Rica'))::int)::text,
             2, '0'
           )
        || CASE
             WHEN (EXTRACT(HOUR FROM (ds."scheduledAt" AT TIME ZONE 'America/Costa_Rica'))::int) >= 12
               THEN 'PM '
             ELSE 'AM '
           END
      ),
      'loteriaId',             ds."loteriaId"::text,
      'loteriaName',           COALESCE(ds.loteria_name, 'Desconocida'),
      'winningNumber',         ds."winningNumber",
      'isReventado',           (ds."extraMultiplierId" IS NOT NULL
                                 OR COALESCE(ds."extraMultiplierX", 0) > 0),
      'totalSales',            ds.s_sales,
      'totalCommission',       COALESCE(rps.vendor_commission, ds.s_commission_total),
      'commissionByNumber',    COALESCE(rps.comm_num, 0),
      'commissionByReventado', COALESCE(rps.comm_rev, 0),
      'totalPrizes',           ds.s_prizes,
      'ticketCount',           ds.s_tickets,
      'subtotal',              ds.s_sales
                               - COALESCE(rps.vendor_commission, ds.s_commission_total)
                               - ds.s_prizes,
      'accumulated',           0,
      'chronologicalIndex',    0,
      'totalChronological',    0,
      'winningTicketsCount',   COALESCE(rps.winning_count, 0),
      'paidTicketsCount',      COALESCE(rps.paid_count,    0),
      'unpaidTicketsCount',    COALESCE(rps.winning_count, 0) - COALESCE(rps.paid_count, 0),
      'byMultiplier',          COALESCE(bm.by_multiplier_json, '[]'::jsonb)
    ) AS sorteo_json
  FROM day_sorteos ds
  LEFT JOIN rsm_per_sorteo rps
    ON rps."vendedorId" = ds."vendedorId" AND rps."sorteoId" = ds.sorteo_id
  LEFT JOIN by_mult bm
    ON bm."vendedorId" = ds."vendedorId" AND bm."sorteoId" = ds.sorteo_id
),

-- 14. Array de sorteos por vendedor
vendor_sorteos AS (
  SELECT
    "vendedorId",
    jsonb_agg(sorteo_json ORDER BY "scheduledAt" ASC) AS sorteos_array
  FROM sorteo_items
  GROUP BY "vendedorId"
),

-- 15. Pagos y cobros del dia
day_payments AS (
  SELECT
    ap."vendedorId",
    jsonb_agg(
      jsonb_build_object(
        'sorteoId',              'mov-' || ap.id::text,
        'sorteoName',            CASE WHEN ap.type = 'payment'
                                      THEN 'Pago recibido'
                                      ELSE 'Cobro realizado' END,
        'scheduledAt',           to_char(ap."createdAt" AT TIME ZONE 'UTC',
                                         'YYYY-MM-DD"T"HH24:MI:SS'),
        'date',                  to_char(ap.date, 'YYYY-MM-DD'),
        'time',                  COALESCE(ap.time, ''),
        'loteriaId',             NULL::text,
        'loteriaName',           NULL::text,
        'winningNumber',         NULL::text,
        'isReventado',           false,
        'totalSales',            0,
        'totalCommission',       0,
        'commissionByNumber',    0,
        'commissionByReventado', 0,
        'totalPrizes',           0,
        'ticketCount',           0,
        'subtotal',              CASE WHEN ap.type = 'payment'
                                      THEN ap.amount
                                      ELSE -ap.amount END,
        'accumulated',           0,
        'chronologicalIndex',    0,
        'totalChronological',    0,
        'winningTicketsCount',   0,
        'paidTicketsCount',      0,
        'unpaidTicketsCount',    0,
        'byMultiplier',          '[]'::jsonb,
        'type',                  ap.type,
        'amount',                ap.amount,
        'method',                COALESCE(ap.method, ''),
        'notes',                 COALESCE(ap.notes, '')
      )
      ORDER BY ap."createdAt" ASC
    ) AS payments_array
  FROM "AccountPayment" ap
  CROSS JOIN sorteo_date sd
  WHERE ap."vendedorId" IN (SELECT id FROM vendors)
    AND ap."isReversed" = false
    AND ap.date = sd.biz_date
  GROUP BY ap."vendedorId"
)

-- ENSAMBLADO FINAL
SELECT
  v.id::UUID AS user_id,

  -- summaryOnly=true payload
  jsonb_build_object(
    'data', (
      CASE
        WHEN COALESCE(ds.total_sales, 0) > 0
          OR COALESCE(ds.accumulated, 0) <> 0
        THEN jsonb_build_array(
          jsonb_build_object(
            'date',    to_char(sd.biz_date, 'YYYY-MM-DD'),
            'sorteos', '[]'::jsonb,
            'dayTotals', jsonb_build_object(
              'totalSales',            COALESCE(ds.total_sales,       0),
              'totalCommission',       COALESCE(ds.total_commission,  0),
              'commissionByNumber',    COALESCE(dr.comm_num,          0),
              'commissionByReventado', COALESCE(dr.comm_rev,          0),
              'totalPrizes',           COALESCE(ds.total_prizes,      0),
              'totalTickets',          CASE WHEN COALESCE(dr.rcd_tickets, 0) > 0
                                            THEN dr.rcd_tickets
                                            ELSE COALESCE(ds.total_tickets, 0) END,
              'totalPaid',             COALESCE(ds.total_paid,        0),
              'totalCollected',        COALESCE(ds.total_collected,   0),
              'totalBalance',          COALESCE(ds.day_balance,       0),
              'totalRemainingBalance', COALESCE(ds.day_balance,       0),
              'totalSubtotal',         COALESCE(ds.day_balance,       0),
              'accumulated',           COALESCE(ds.accumulated,       0)
            )
          )
        )
        ELSE '[]'::jsonb
      END
    ),
    'meta', jsonb_build_object(
      'totals', jsonb_build_object(
        'totalSales',            COALESCE(ds.total_sales,       0),
        'totalCommission',       COALESCE(ds.total_commission,  0),
        'commissionByNumber',    COALESCE(dr.comm_num,          0),
        'commissionByReventado', COALESCE(dr.comm_rev,          0),
        'totalPrizes',           COALESCE(ds.total_prizes,      0),
        'totalTickets',          CASE WHEN COALESCE(dr.rcd_tickets, 0) > 0
                                      THEN dr.rcd_tickets
                                      ELSE COALESCE(ds.total_tickets, 0) END,
        'totalPaid',             COALESCE(ds.total_paid,        0),
        'totalCollected',        COALESCE(ds.total_collected,   0),
        'totalBalance',          COALESCE(ds.day_balance,       0),
        'totalRemainingBalance', COALESCE(ds.day_balance,       0),
        'totalSubtotal',         COALESCE(ds.day_balance,       0)
      ),
      'monthlyAccumulated', jsonb_build_object(
        'totalSales',            COALESCE(mr.m_sales,           0),
        'totalCommission',       COALESCE(mr.m_commission,      0),
        'commissionByNumber',    COALESCE(mr.m_comm_num,        0),
        'commissionByReventado', COALESCE(mr.m_comm_rev,        0),
        'totalPrizes',           COALESCE(mr.m_prizes,          0),
        'totalTickets',          COALESCE(mr.m_tickets,         0),
        'totalPaid',             COALESCE(mp.m_paid,            0),
        'totalCollected',        COALESCE(mp.m_collected,       0),
        'totalBalance',
          COALESCE(pmb.prev_balance, 0)
          + COALESCE(mr.m_sales,     0)
          - COALESCE(mr.m_prizes,    0)
          - COALESCE(mr.m_commission,0),
        'totalRemainingBalance',
          COALESCE(pmb.prev_balance,  0)
          + COALESCE(mr.m_sales,      0)
          - COALESCE(mr.m_prizes,     0)
          - COALESCE(mr.m_commission, 0)
          - COALESCE(mp.m_collected,  0)
          + COALESCE(mp.m_paid,       0),
        'totalSubtotal',
          COALESCE(pmb.prev_balance,  0)
          + COALESCE(mr.m_sales,      0)
          - COALESCE(mr.m_prizes,     0)
          - COALESCE(mr.m_commission, 0)
          - COALESCE(mp.m_collected,  0)
          + COALESCE(mp.m_paid,       0)
      ),
      'dateFilter',   'today',
      'totalSorteos', COALESCE(dr.total_sorteos, 0)::int,
      'totalDays',
        CASE WHEN COALESCE(ds.total_sales, 0) > 0
               OR COALESCE(ds.accumulated, 0) <> 0
             THEN 1 ELSE 0 END
    )
  )::jsonb AS summary_only_payload,

  -- summaryOnly=false payload
  jsonb_build_object(
    'data', (
      CASE
        WHEN vs.sorteos_array  IS NOT NULL
          OR dp.payments_array IS NOT NULL
          OR COALESCE(ds.total_sales, 0) > 0
          OR COALESCE(ds.accumulated, 0) <> 0
        THEN jsonb_build_array(
          jsonb_build_object(
            'date',    to_char(sd.biz_date, 'YYYY-MM-DD'),
            'sorteos', COALESCE(vs.sorteos_array, '[]'::jsonb)
                       || COALESCE(dp.payments_array, '[]'::jsonb),
            'dayTotals', jsonb_build_object(
              'totalSales',            COALESCE(ds.total_sales,       0),
              'totalCommission',       COALESCE(ds.total_commission,  0),
              'commissionByNumber',    COALESCE(dr.comm_num,          0),
              'commissionByReventado', COALESCE(dr.comm_rev,          0),
              'totalPrizes',           COALESCE(ds.total_prizes,      0),
              'totalTickets',          CASE WHEN COALESCE(dr.rcd_tickets, 0) > 0
                                            THEN dr.rcd_tickets
                                            ELSE COALESCE(ds.total_tickets, 0) END,
              'totalPaid',             COALESCE(ds.total_paid,        0),
              'totalCollected',        COALESCE(ds.total_collected,   0),
              'totalBalance',          COALESCE(ds.day_balance,       0),
              'totalRemainingBalance', COALESCE(ds.day_balance,       0),
              'totalSubtotal',         COALESCE(ds.day_balance,       0),
              'accumulated',           COALESCE(ds.accumulated,       0)
            )
          )
        )
        ELSE '[]'::jsonb
      END
    ),
    'meta', jsonb_build_object(
      'totals', jsonb_build_object(
        'totalSales',            COALESCE(ds.total_sales,       0),
        'totalCommission',       COALESCE(ds.total_commission,  0),
        'commissionByNumber',    COALESCE(dr.comm_num,          0),
        'commissionByReventado', COALESCE(dr.comm_rev,          0),
        'totalPrizes',           COALESCE(ds.total_prizes,      0),
        'totalTickets',          CASE WHEN COALESCE(dr.rcd_tickets, 0) > 0
                                      THEN dr.rcd_tickets
                                      ELSE COALESCE(ds.total_tickets, 0) END,
        'totalPaid',             COALESCE(ds.total_paid,        0),
        'totalCollected',        COALESCE(ds.total_collected,   0),
        'totalBalance',          COALESCE(ds.day_balance,       0),
        'totalRemainingBalance', COALESCE(ds.day_balance,       0),
        'totalSubtotal',         COALESCE(ds.day_balance,       0)
      ),
      'monthlyAccumulated', jsonb_build_object(
        'totalSales',            COALESCE(mr.m_sales,           0),
        'totalCommission',       COALESCE(mr.m_commission,      0),
        'commissionByNumber',    COALESCE(mr.m_comm_num,        0),
        'commissionByReventado', COALESCE(mr.m_comm_rev,        0),
        'totalPrizes',           COALESCE(mr.m_prizes,          0),
        'totalTickets',          COALESCE(mr.m_tickets,         0),
        'totalPaid',             COALESCE(mp.m_paid,            0),
        'totalCollected',        COALESCE(mp.m_collected,       0),
        'totalBalance',
          COALESCE(pmb.prev_balance, 0)
          + COALESCE(mr.m_sales,     0)
          - COALESCE(mr.m_prizes,    0)
          - COALESCE(mr.m_commission,0),
        'totalRemainingBalance',
          COALESCE(pmb.prev_balance,  0)
          + COALESCE(mr.m_sales,      0)
          - COALESCE(mr.m_prizes,     0)
          - COALESCE(mr.m_commission, 0)
          - COALESCE(mp.m_collected,  0)
          + COALESCE(mp.m_paid,       0),
        'totalSubtotal',
          COALESCE(pmb.prev_balance,  0)
          + COALESCE(mr.m_sales,      0)
          - COALESCE(mr.m_prizes,     0)
          - COALESCE(mr.m_commission, 0)
          - COALESCE(mp.m_collected,  0)
          + COALESCE(mp.m_paid,       0)
      ),
      'dateFilter',   'today',
      'totalSorteos', COALESCE(dr.total_sorteos, 0)::int,
      'totalDays',
        CASE WHEN vs.sorteos_array  IS NOT NULL
               OR dp.payments_array IS NOT NULL
               OR COALESCE(ds.total_sales, 0) > 0
               OR COALESCE(ds.accumulated, 0) <> 0
             THEN 1 ELSE 0 END
    )
  )::jsonb AS full_payload,

  -- initial_accumulated
  COALESCE(pds.prev_accumulated, 0)::numeric AS initial_accumulated

FROM vendors v
CROSS JOIN sorteo_date sd
LEFT JOIN day_stmt           ds  ON ds."vendedorId"  = v.id
LEFT JOIN day_rcd            dr  ON dr."vendedorId"  = v.id
LEFT JOIN month_rcd          mr  ON mr."vendedorId"  = v.id
LEFT JOIN prev_month_balance pmb ON pmb."vendedorId" = v.id
LEFT JOIN month_payments     mp  ON mp."vendedorId"  = v.id
LEFT JOIN vendor_sorteos     vs  ON vs."vendedorId"  = v.id
LEFT JOIN day_payments       dp  ON dp."vendedorId"  = v.id
LEFT JOIN prev_day_stmt      pds ON pds."vendedorId" = v.id
$$;