-- ============================================
-- FASE 4: Validaciones en PostgreSQL
-- ============================================
-- Esta migración crea funciones de validación para AccountPayment
-- que se ejecutan automáticamente antes de insertar/actualizar.
--
-- ROLLBACK SEGURO: Las validaciones pueden eliminarse sin afectar datos existentes.
-- El código backend puede volver a validar manualmente.
--
-- Fecha: 2025-01-29
-- ============================================

-- ============================================
-- Función: Validar AccountPayment
-- ============================================
-- Valida que el monto sea positivo y otros requisitos básicos
CREATE OR REPLACE FUNCTION validate_account_payment()
RETURNS TRIGGER AS $$
BEGIN
    -- Validar que el monto sea positivo
    IF NEW.amount IS NULL OR NEW.amount <= 0 THEN
        RAISE EXCEPTION 'El monto debe ser positivo. Valor recibido: %', NEW.amount
        USING ERRCODE = '23514'; -- check_violation
    END IF;
    
    -- Validar que el tipo sea válido
    IF NEW.type NOT IN ('payment', 'collection') THEN
        RAISE EXCEPTION 'El tipo de movimiento debe ser "payment" o "collection". Valor recibido: %', NEW.type
        USING ERRCODE = '23514';
    END IF;
    
    -- Validar que accountStatementId no sea NULL
    IF NEW."accountStatementId" IS NULL THEN
        RAISE EXCEPTION 'El accountStatementId no puede ser NULL'
        USING ERRCODE = '23514';
    END IF;
    
    -- Validar que la fecha no sea NULL
    IF NEW.date IS NULL THEN
        RAISE EXCEPTION 'La fecha no puede ser NULL'
        USING ERRCODE = '23514';
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Trigger: Validar antes de insertar/actualizar
-- ============================================
DROP TRIGGER IF EXISTS validate_account_payment_trigger ON "AccountPayment";

CREATE TRIGGER validate_account_payment_trigger
    BEFORE INSERT OR UPDATE ON "AccountPayment"
    FOR EACH ROW
    EXECUTE FUNCTION validate_account_payment();

-- ============================================
-- Función: Validar que no se revierta un pago ya revertido
-- ============================================
CREATE OR REPLACE FUNCTION validate_payment_reversal()
RETURNS TRIGGER AS $$
BEGIN
    -- Si se está marcando como revertido, validar que no esté ya revertido
    IF NEW."isReversed" = true AND OLD."isReversed" = false THEN
        -- Ya está validado por el trigger, solo retornar
        RETURN NEW;
    END IF;
    
    -- Si se intenta des-revertir (isReversed: true -> false), prevenir
    IF NEW."isReversed" = false AND OLD."isReversed" = true THEN
        RAISE EXCEPTION 'No se puede des-revertir un pago que ya fue revertido'
        USING ERRCODE = '23514';
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Trigger: Validar reversión
-- ============================================
DROP TRIGGER IF EXISTS validate_payment_reversal_trigger ON "AccountPayment";

CREATE TRIGGER validate_payment_reversal_trigger
    BEFORE UPDATE ON "AccountPayment"
    FOR EACH ROW
    WHEN (OLD."isReversed" IS DISTINCT FROM NEW."isReversed")
    EXECUTE FUNCTION validate_payment_reversal();

-- ============================================
-- Comentarios para documentación
-- ============================================
COMMENT ON FUNCTION validate_account_payment() IS 
'Valida que AccountPayment tenga datos válidos: monto positivo, tipo válido, accountStatementId y date no nulos.';

COMMENT ON FUNCTION validate_payment_reversal() IS 
'Valida que no se pueda des-revertir un pago que ya fue revertido.';


