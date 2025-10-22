-- Crear secuencia si no existe
CREATE SEQUENCE IF NOT EXISTS ticket_number_seq
  START WITH 1
  INCREMENT BY 1
  NO MAXVALUE
  CACHE 1;

-- Crear función robusta con manejo de conflictos
CREATE OR REPLACE FUNCTION generate_ticket_number()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  next_num INTEGER;
  max_retries INTEGER := 3;
  retry_count INTEGER := 0;
BEGIN
  LOOP
    BEGIN
      SELECT nextval('ticket_number_seq') INTO next_num;

      PERFORM 1 FROM "Ticket" WHERE "ticketNumber" = next_num;

      IF NOT FOUND THEN
        RETURN next_num;
      END IF;

      retry_count := retry_count + 1;
      IF retry_count >= max_retries THEN
        RAISE EXCEPTION 'Failed to generate unique ticket number after % retries', max_retries;
      END IF;

    EXCEPTION WHEN OTHERS THEN
      IF retry_count >= max_retries THEN
        RAISE;
      END IF;
      retry_count := retry_count + 1;
    END;
  END LOOP;
END;
$$;