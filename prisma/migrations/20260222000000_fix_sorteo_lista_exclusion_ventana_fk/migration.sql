-- Fix: sorteo_lista_exclusion.ventana_id FK was incorrectly pointing to "User" instead of "Ventana"
-- La tabla referencia Ventana.id (branch), no User.id, consistente con el resto del codebase

ALTER TABLE "sorteo_lista_exclusion" DROP CONSTRAINT "sorteo_lista_exclusion_ventana_id_fkey";

ALTER TABLE "sorteo_lista_exclusion"
  ADD CONSTRAINT "sorteo_lista_exclusion_ventana_id_fkey"
  FOREIGN KEY (ventana_id) REFERENCES "Ventana"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
