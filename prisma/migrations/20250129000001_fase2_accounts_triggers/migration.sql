-- ============================================
-- FASE 2: Triggers para Automatización de AccountStatement
-- ============================================
-- Esta migración crea triggers que actualizan automáticamente AccountStatement
-- cuando se insertan, actualizan o eliminan registros en AccountPayment.
--
-- ROLLBACK SEGURO: Los triggers pueden deshabilitarse/eliminarse sin afectar datos.
-- El código backend puede volver a actualizar manualmente los statements.
--
-- IMPORTANTE: Esta fase depende de la Fase 1 (usa get_account_payment_totals si existe).
-- Si la Fase 1 no está aplicada, el trigger calculará totales directamente.
--
-- Fecha: 2025-01-29
-- ============================================

-- ============================================
-- Función del Trigger: update_account_statement_on_payment_change
-- ============================================
-- Actualiza automáticamente AccountStatement cuando cambia AccountPayment
-- Reemplaza actualizaciones manuales en accounts.movements.ts (líneas 164-178, 349-363)
--
-- Lógica:
--   1. Determina el accountStatementId del payment afectado
--   2. Calcula totales de pagos/cobros (usando función de Fase 1 si existe, sino directamente)
--   3. Obtiene balance base del statement
--   4. Calcula remainingBalance = balance - totalCollected + totalPaid
--   5. Calcula isSettled usando la misma lógica que calculateIsSettled()
--   6. Actualiza el statement
-- ============================================

CREATE OR REPLACE FUNCTION update_account_statement_on_payment_change()
RETURNS TRIGGER AS $$
DECLARE
    v_statement_id UUID;
    v_total_paid NUMERIC;
    v_total_collected NUMERIC;
    v_base_balance NUMERIC;
    v_remaining_balance NUMERIC;
    v_ticket_count INTEGER;
    v_is_settled BOOLEAN;
    v_has_payments BOOLEAN;
BEGIN
    -- Determinar statement_id según operación
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        v_statement_id := NEW."accountStatementId";
    ELSE
        v_statement_id := OLD."accountStatementId";
    END IF;
    
    -- Si no hay statement_id, no hacer nada (caso edge)
    IF v_statement_id IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    -- Calcular totales de movimientos
    -- Intentar usar función de Fase 1 si existe, sino calcular directamente
    BEGIN
        SELECT total_paid, total_collected INTO v_total_paid, v_total_collected
        FROM get_account_payment_totals(v_statement_id);
    EXCEPTION WHEN OTHERS THEN
        -- Si la función no existe (Fase 1 no aplicada), calcular directamente
        SELECT
            COALESCE(SUM(CASE WHEN type = 'payment' AND NOT "isReversed" THEN amount ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN type = 'collection' AND NOT "isReversed" THEN amount ELSE 0 END), 0)
        INTO v_total_paid, v_total_collected
        FROM "AccountPayment"
        WHERE "accountStatementId" = v_statement_id;
    END;
    
    -- Obtener balance base y ticket_count del statement
    SELECT balance, "ticketCount" INTO v_base_balance, v_ticket_count
    FROM "AccountStatement"
    WHERE id = v_statement_id;
    
    -- Si no existe el statement, no hacer nada (caso edge)
    IF v_base_balance IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    -- Calcular remainingBalance
    -- Fórmula: remainingBalance = balance - totalCollected + totalPaid
    v_remaining_balance := v_base_balance - v_total_collected + v_total_paid;
    
    -- Calcular isSettled
    -- Lógica: ticketCount > 0 AND ABS(remainingBalance) < 0.01 AND (totalPaid > 0 OR totalCollected > 0)
    v_has_payments := (v_total_paid > 0 OR v_total_collected > 0);
    v_is_settled := (
        v_ticket_count > 0
        AND ABS(v_remaining_balance) < 0.01
        AND v_has_payments
    );
    
    -- Actualizar statement
    UPDATE "AccountStatement"
    SET
        "totalPaid" = v_total_paid,
        "totalCollected" = v_total_collected,
        "remainingBalance" = v_remaining_balance,
        "isSettled" = v_is_settled,
        "canEdit" = NOT v_is_settled,
        "updatedAt" = NOW()
    WHERE id = v_statement_id;
    
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Trigger: account_payment_trigger
-- ============================================
-- Se ejecuta después de INSERT, UPDATE o DELETE en AccountPayment
-- ============================================

DROP TRIGGER IF EXISTS account_payment_trigger ON "AccountPayment";

CREATE TRIGGER account_payment_trigger
    AFTER INSERT OR UPDATE OR DELETE ON "AccountPayment"
    FOR EACH ROW
    EXECUTE FUNCTION update_account_statement_on_payment_change();

-- ============================================
-- Comentarios para documentación
-- ============================================

COMMENT ON FUNCTION update_account_statement_on_payment_change IS 
'Actualiza automáticamente AccountStatement cuando cambia AccountPayment. Reemplaza actualizaciones manuales del backend.';

COMMENT ON TRIGGER account_payment_trigger ON "AccountPayment" IS 
'Trigger que actualiza AccountStatement automáticamente al cambiar AccountPayment.';


