-- Extensión TRGM (en Supabase suele estar, igual protegemos)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Loteria
CREATE INDEX IF NOT EXISTS idx_loteria_name_trgm
  ON public."Loteria" USING gin ("name" gin_trgm_ops);

-- Sorteo
CREATE INDEX IF NOT EXISTS idx_sorteo_name_trgm
  ON public."Sorteo" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_sorteo_winning_trgm
  ON public."Sorteo" USING gin ("winningNumber" gin_trgm_ops);

-- User
CREATE INDEX IF NOT EXISTS idx_user_code_trgm
  ON public."User" USING gin ("code" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_user_email_trgm
  ON public."User" USING gin ("email" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_user_name_trgm
  ON public."User" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_user_username_trgm
  ON public."User" USING gin ("username" gin_trgm_ops);

-- Ventana
CREATE INDEX IF NOT EXISTS idx_ventana_code_trgm
  ON public."Ventana" USING gin ("code" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_ventana_email_trgm
  ON public."Ventana" USING gin ("email" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_ventana_name_trgm
  ON public."Ventana" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_ventana_phone_trgm
  ON public."Ventana" USING gin ("phone" gin_trgm_ops);

-- Asegura la extensión necesaria (por si en algún momento generas UUIDs o usas funciones cripto)
-- CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -- 1) Crea la secuencia si no existe
-- CREATE SEQUENCE IF NOT EXISTS public.ticket_number_seq
--   INCREMENT BY 1
--   MINVALUE 1
--   START WITH 1
--   CACHE 1;

-- -- 2) Asegura que la secuencia esté "OWNED BY" la columna (para que siga el ciclo de vida de la tabla)
-- DO $$
-- BEGIN
--   PERFORM 1
--   FROM pg_depend d
--   JOIN pg_class  c ON c.oid = d.refobjid
--   JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
--   WHERE d.objid = 'public.ticket_number_seq'::regclass
--     AND c.relname = 'Ticket'
--     AND a.attname = 'ticketNumber';

--   IF NOT FOUND THEN
--     ALTER SEQUENCE public.ticket_number_seq OWNED BY public."Ticket"."ticketNumber";
--   END IF;
-- END $$;

-- -- 3) Sincroniza el valor de la secuencia con el máximo actual (idempotente)
-- SELECT setval(
--   'public.ticket_number_seq',
--   COALESCE((SELECT MAX("ticketNumber") FROM public."Ticket"), 0)
-- );

-- -- 4) DEFAULT en la columna: toma valor de la secuencia al insertar
-- ALTER TABLE public."Ticket"
--   ALTER COLUMN "ticketNumber" SET DEFAULT nextval('public.ticket_number_seq');

-- -- 5) (Opcional) Deja también tu función, casteando a int/bigint según necesites.
-- --    Si tu código la llama en algún lado, seguirá funcionando.
-- CREATE OR REPLACE FUNCTION public.generate_ticket_number()
-- RETURNS bigint
-- LANGUAGE sql
-- AS $FN$
--   SELECT nextval('public.ticket_number_seq')::bigint;
-- $FN$;

-- 6) (Opcional) Si quieres obligar que siempre se asigne cuando venga NULL, puedes usar un trigger:
--    Si prefieres SOLO el DEFAULT (más simple), omite lo siguiente.

-- DROP TRIGGER IF EXISTS trg_assign_ticket_number ON public."Ticket";
-- CREATE OR REPLACE FUNCTION public.assign_ticket_number()
-- RETURNS trigger
-- LANGUAGE plpgsql
-- AS $$
-- BEGIN
--   IF NEW."ticketNumber" IS NULL THEN
--     NEW."ticketNumber" = nextval('public.ticket_number_seq')::int;
--   END IF;
--   RETURN NEW;
-- END;
-- $$;
-- CREATE TRIGGER trg_assign_ticket_number
-- BEFORE INSERT ON public."Ticket"
-- FOR EACH ROW
-- EXECUTE FUNCTION public.assign_ticket_number();


