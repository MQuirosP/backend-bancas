-- ============================================================
-- Función: calculate_account_statement_aggregates
-- Exportado: 2026-08-27T17:50:39.125Z
-- Fuente: pg_proc (schema: public)
-- ============================================================
BEGIN
    RETURN QUERY
    WITH business_date_expr AS (
        SELECT
            COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')))::DATE as business_date,
            b.id as banca_id,
            t."ventanaId" as ventana_id,
            t."vendedorId" as vendedor_id,
            t.id as ticket_id,
            j.amount as jugada_amount,
            j."listeroCommissionAmount" as listero_commission,
            CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END as vendedor_commission
        FROM "Ticket" t
        INNER JOIN "Jugada" j ON j."ticketId" = t.id AND j."deletedAt" IS NULL
        INNER JOIN "Ventana" v ON v.id = t."ventanaId"
        INNER JOIN "Banca" b ON b.id = v."bancaId"
        LEFT JOIN "User" u ON u.id = t."vendedorId"
        WHERE
            t."deletedAt" IS NULL
            AND t."isActive" = true
            AND t."status" != 'CANCELLED'
            AND EXISTS (SELECT 1 FROM "Sorteo" s WHERE s.id = t."sorteoId" AND s.status = 'EVALUATED')
            AND COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) >= p_start_date
            AND COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) <= p_end_date
            AND NOT EXISTS (
                SELECT 1 FROM "sorteo_lista_exclusion" sle
                WHERE sle.sorteo_id = t."sorteoId"
                AND sle.ventana_id = t."ventanaId"
                AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
            )
            -- Filtros según dimensión
            AND (p_banca_id IS NULL OR EXISTS (SELECT 1 FROM "Ventana" v2 WHERE v2.id = t."ventanaId" AND v2."bancaId" = p_banca_id))
            AND (
                (p_dimension = 'banca' AND (
                    (p_ventana_id IS NULL OR t."ventanaId" = p_ventana_id)
                    AND (p_vendedor_id IS NULL OR t."vendedorId" = p_vendedor_id)
                    AND (p_ventana_id IS NULL OR p_banca_id IS NULL OR EXISTS (SELECT 1 FROM "Ventana" v3 WHERE v3.id = p_ventana_id AND v3."bancaId" = p_banca_id))
                    AND (p_vendedor_id IS NULL OR p_banca_id IS NULL OR EXISTS (SELECT 1 FROM "Ventana" v4 JOIN "User" u2 ON u2."ventanaId" = v4.id WHERE u2.id = p_vendedor_id AND v4."bancaId" = p_banca_id))
                    AND (p_vendedor_id IS NULL OR p_ventana_id IS NULL OR EXISTS (SELECT 1 FROM "User" u3 WHERE u3.id = p_vendedor_id AND u3."ventanaId" = p_ventana_id))
                ))
                OR (p_dimension = 'ventana' AND (
                    (p_ventana_id IS NULL OR t."ventanaId" = p_ventana_id)
                    AND (p_vendedor_id IS NULL OR t."vendedorId" = p_vendedor_id)
                    AND (p_banca_id IS NULL OR EXISTS (SELECT 1 FROM "Ventana" v5 WHERE v5.id = t."ventanaId" AND v5."bancaId" = p_banca_id))
                ))
                OR (p_dimension = 'vendedor' AND (
                    (p_vendedor_id IS NULL OR t."vendedorId" = p_vendedor_id)
                    AND (p_ventana_id IS NULL OR t."ventanaId" = p_ventana_id)
                    AND (p_banca_id IS NULL OR EXISTS (SELECT 1 FROM "Ventana" v6 JOIN "User" u4 ON u4."ventanaId" = v6.id WHERE u4.id = t."vendedorId" AND v6."bancaId" = p_banca_id))
                ))
            )
    )
    SELECT
        bde.business_date,
        bde.banca_id,
        MAX(b.name)::TEXT as banca_name,
        MAX(b.code)::TEXT as banca_code,
        CASE WHEN p_should_group_by_date THEN NULL::UUID ELSE bde.ventana_id END as ventana_id,
        MAX(v.name)::TEXT as ventana_name,
        MAX(v.code)::TEXT as ventana_code,
        CASE WHEN p_should_group_by_date THEN NULL::UUID ELSE bde.vendedor_id END as vendedor_id,
        MAX(u.name)::TEXT as vendedor_name,
        MAX(u.code)::TEXT as vendedor_code,
        COALESCE(SUM(bde.jugada_amount), 0)::NUMERIC as total_sales,
        0::NUMERIC as total_payouts,
        COUNT(DISTINCT bde.ticket_id)::BIGINT as total_tickets,
        COALESCE(SUM(bde.listero_commission), 0)::NUMERIC as commission_listero,
        COALESCE(SUM(bde.vendedor_commission), 0)::NUMERIC as commission_vendedor
    FROM business_date_expr bde
    INNER JOIN "Banca" b ON b.id = bde.banca_id
    LEFT JOIN "Ventana" v ON v.id = bde.ventana_id
    LEFT JOIN "User" u ON u.id = bde.vendedor_id
    GROUP BY
        bde.business_date,
        bde.banca_id,
        CASE WHEN p_should_group_by_date THEN NULL::UUID ELSE bde.ventana_id END,
        CASE WHEN p_should_group_by_date THEN NULL::UUID ELSE bde.vendedor_id END
    ORDER BY bde.business_date DESC
    LIMIT NULLIF(p_limit, 0);
END;
