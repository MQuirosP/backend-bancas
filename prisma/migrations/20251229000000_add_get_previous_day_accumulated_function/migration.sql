-- ✅ MIGRACIÓN SEGURA: Función para obtener acumulado progresivo del día anterior
-- Esta función es idempotente (CREATE OR REPLACE) y no modifica datos existentes
-- Solo crea una función PostgreSQL que puede ser usada por el backend

-- Función optimizada para obtener el acumulado progresivo del día anterior
-- Usa Window Functions para calcular eficientemente el acumulado desde inicio del mes
-- 
-- Lógica:
-- 1. Calcula el acumulado progresivo desde inicio del mes hasta el día anterior
-- 2. Para dimension='banca' con bancaId: suma todos los balances de todas las ventanas de esa banca
-- 3. Para dimension='ventana' con ventanaId: usa solo statements de esa ventana (vendedorId IS NULL)
-- 4. Para dimension='vendedor' con vendedorId: usa solo statements de ese vendedor
CREATE OR REPLACE FUNCTION get_previous_day_accumulated(
    p_date DATE,
    p_dimension TEXT,
    p_banca_id UUID DEFAULT NULL,
    p_ventana_id UUID DEFAULT NULL,
    p_vendedor_id UUID DEFAULT NULL
) RETURNS NUMERIC AS $$
DECLARE
    v_previous_date DATE;
    v_month_start DATE;
    v_accumulated NUMERIC := 0;
BEGIN
    -- Calcular fecha del día anterior
    v_previous_date := p_date - INTERVAL '1 day';
    
    -- Calcular inicio del mes
    v_month_start := DATE_TRUNC('month', p_date)::DATE;
    
    -- Si el día anterior es de un mes diferente, retornar 0
    -- (el acumulado debe ser desde el inicio del mes actual)
    IF DATE_TRUNC('month', v_previous_date)::DATE < v_month_start THEN
        RETURN 0;
    END IF;
    
    -- ✅ CRÍTICO: Calcular acumulado progresivo hasta día anterior (sin incluir día anterior)
    -- Usamos balance (que ya incluye movimientos: balanceBase + totalPaid - totalCollected)
    -- El backend sumará el accumulated interno del día anterior (sorteos + movimientos dentro del día)
    -- para obtener el acumulado total progresivo del día anterior
    -- NOTA: El balance del statement es aproximadamente igual al lastAccumulatedOfDay del día
    
    IF p_dimension = 'vendedor' AND p_vendedor_id IS NOT NULL THEN
        -- Caso 1: Vendedor específico
        WITH daily_balances AS (
            SELECT 
                ast."date",
                SUM(ast.balance) OVER (
                    ORDER BY ast."date" ASC
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) as accumulated_balance
            FROM "AccountStatement" ast
            WHERE ast."date" >= v_month_start
            AND ast."date" < v_previous_date  -- ⚠️ CRÍTICO: < en lugar de <= para NO incluir el día anterior
            AND ast."vendedorId" = p_vendedor_id
            -- ⚠️ NO filtrar por isSettled: necesitamos todos los statements para calcular el acumulado correcto
        )
        -- Obtener el último acumulado (del último día antes del día anterior)
        SELECT COALESCE(MAX(accumulated_balance), 0)
        INTO v_accumulated
        FROM daily_balances;
        
    ELSIF p_dimension = 'ventana' AND p_ventana_id IS NOT NULL THEN
        -- Caso 2: Ventana específica (solo statements consolidados, sin vendedorId)
        WITH daily_balances AS (
            SELECT 
                ast."date",
                SUM(ast.balance) OVER (
                    ORDER BY ast."date" ASC
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) as accumulated_balance
            FROM "AccountStatement" ast
            WHERE ast."date" >= v_month_start
            AND ast."date" < v_previous_date  -- ⚠️ CRÍTICO: < en lugar de <= para NO incluir el día anterior
            AND ast."ventanaId" = p_ventana_id
            AND ast."vendedorId" IS NULL
            -- ⚠️ NO filtrar por isSettled: necesitamos todos los statements para calcular el acumulado correcto
        )
        -- Obtener el último acumulado (del último día antes del día anterior)
        SELECT COALESCE(MAX(accumulated_balance), 0)
        INTO v_accumulated
        FROM daily_balances;
        
    ELSIF p_dimension = 'banca' AND p_banca_id IS NOT NULL THEN
        -- Caso 3: Banca específica - sumar todos los remainingBalance de todas las ventanas de esa banca por fecha
        WITH daily_aggregated AS (
            SELECT 
                ast."date",
                SUM(ast.balance) as daily_balance
            FROM "AccountStatement" ast
            WHERE ast."date" >= v_month_start
            AND ast."date" < v_previous_date  -- ⚠️ CRÍTICO: < en lugar de <= para NO incluir el día anterior
            AND (
                ast."bancaId" = p_banca_id
                OR (ast."bancaId" IS NULL AND EXISTS (
                    SELECT 1 FROM "Ventana" v 
                    WHERE v.id = ast."ventanaId" 
                    AND v."bancaId" = p_banca_id
                ))
            )
            AND ast."vendedorId" IS NULL  -- Solo statements consolidados de ventana
            -- ⚠️ NO filtrar por isSettled: necesitamos todos los statements para calcular el acumulado correcto
            GROUP BY ast."date"
        ),
        daily_balances AS (
            SELECT 
                "date",
                SUM(daily_balance) OVER (
                    ORDER BY "date" ASC
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) as accumulated_balance
            FROM daily_aggregated
        )
        -- Obtener el último acumulado (del último día antes del día anterior)
        SELECT COALESCE(MAX(accumulated_balance), 0)
        INTO v_accumulated
        FROM daily_balances;
        
    ELSE
        -- Caso 4: Sin filtros específicos (agrupación por todas las entidades de la dimensión)
        -- Sumar todos los balance por fecha según la dimensión y luego calcular acumulado
        WITH daily_aggregated AS (
            SELECT 
                ast."date",
                SUM(ast.balance) as daily_balance
            FROM "AccountStatement" ast
            WHERE ast."date" >= v_month_start
            AND ast."date" < v_previous_date  -- ⚠️ CRÍTICO: < en lugar de <= para NO incluir el día anterior
            AND (
                -- Para banca: incluir todos los statements de ventana (vendedorId IS NULL) con o sin bancaId
                (p_dimension = 'banca' AND ast."vendedorId" IS NULL)
                -- Para ventana: incluir todos los statements de ventana (vendedorId IS NULL)
                OR (p_dimension = 'ventana' AND ast."ventanaId" IS NOT NULL AND ast."vendedorId" IS NULL)
                -- Para vendedor: incluir todos los statements de vendedor
                OR (p_dimension = 'vendedor' AND ast."vendedorId" IS NOT NULL)
            )
            -- ⚠️ NO filtrar por isSettled: necesitamos todos los statements para calcular el acumulado correcto
            GROUP BY ast."date"
        ),
        daily_balances AS (
            SELECT 
                "date",
                SUM(daily_balance) OVER (
                    ORDER BY "date" ASC
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) as accumulated_balance
            FROM daily_aggregated
        )
        -- Obtener el último acumulado (del último día antes del día anterior)
        SELECT COALESCE(MAX(accumulated_balance), 0)
        INTO v_accumulated
        FROM daily_balances;
    END IF;
    
    RETURN COALESCE(v_accumulated, 0);
END;
$$ LANGUAGE plpgsql;

-- Comentario de documentación
COMMENT ON FUNCTION get_previous_day_accumulated IS 
'Calcula el acumulado progresivo hasta el día anterior (SIN incluir el día anterior).
Retorna la suma de balance desde inicio del mes hasta el día anterior (excluyendo el día anterior).
El balance del statement es aproximadamente igual al lastAccumulatedOfDay del día (suma de balances de sorteos + movimientos).
El backend debe sumar el accumulated interno del día anterior (sorteos + movimientos dentro del día anterior)
para obtener el acumulado total progresivo del día anterior.';

