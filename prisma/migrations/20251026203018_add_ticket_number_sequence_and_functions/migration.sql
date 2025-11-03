-- Migración A: Secuencia y Funciones para Generación de Ticket Numbers
-- Formato: TYYMMDD-<BASE36(6)>-<CD2>
-- Ejemplo: T250126-00000A-42

-- ============================================================
-- PASO 1: Crear secuencia global para ticket numbers
-- ============================================================
CREATE SEQUENCE IF NOT EXISTS ticket_no_seq
  START WITH 1
  INCREMENT BY 1
  NO MAXVALUE
  CACHE 1;

-- ============================================================
-- PASO 2: Función helper para convertir BIGINT a BASE36
-- ============================================================
-- Convierte un número a base 36 (0-9, A-Z)
-- Usado para generar parte compacta del ticket number
CREATE OR REPLACE FUNCTION to_base36(n BIGINT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  v BIGINT := n;
  r INT;
  s TEXT := '';
  digits TEXT[] := ARRAY[
    '0','1','2','3','4','5','6','7','8','9',
    'A','B','C','D','E','F','G','H','I','J','K','L','M',
    'N','O','P','Q','R','S','T','U','V','W','X','Y','Z'
  ];
BEGIN
  IF v = 0 THEN
    RETURN '0';
  END IF;

  WHILE v > 0 LOOP
    r := (v % 36)::INT;
    s := digits[r+1] || s;
    v := v / 36;
  END LOOP;

  RETURN s;
END $$;

-- ============================================================
-- PASO 3: Función principal de generación de ticket number
-- ============================================================
-- Genera número de tiquete con formato: TYYMMDD-<BASE36(6)>-<CD2>
-- - T: Prefijo literal
-- - YYMMDD: Fecha UTC actual (año, mes, día)
-- - BASE36(6): Secuencia en base 36 con padding a 6 caracteres
-- - CD2: Check digit (seq % 97) con padding a 2 dígitos
--
-- Ejemplos:
-- - Secuencia 1:      T250126-000001-01
-- - Secuencia 10:     T250126-00000A-10
-- - Secuencia 1297:   T250126-000ZZ1-97
CREATE OR REPLACE FUNCTION generate_ticket_number() RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_seq BIGINT := nextval('ticket_no_seq');
  v_b36 TEXT := to_base36(v_seq);
  v_cd  INT  := (v_seq % 97)::INT;
  v_dt  TEXT := to_char((now() AT TIME ZONE 'UTC'), 'YYMMDD');
BEGIN
  RETURN 'T' || v_dt || '-' ||
         lpad(v_b36, 6, '0') || '-' ||
         lpad(v_cd::TEXT, 2, '0');
END $$;

-- ============================================================
-- NOTAS DE IMPLEMENTACIÓN
-- ============================================================
-- 1. Gaps en la secuencia son esperados y deseables (rollbacks)
-- 2. Check digit permite detectar errores de digitación
-- 3. Formato base36 permite representar hasta 2,176,782,336 tickets
--    en 6 caracteres (36^6)
-- 4. La función es segura para concurrencia (nextval es atómico)
-- 5. Fecha en UTC para consistencia global
