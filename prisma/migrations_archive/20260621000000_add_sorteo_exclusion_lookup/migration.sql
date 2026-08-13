-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_sorteo_exclusion_lookup" ON "sorteo_lista_exclusion"("sorteo_id", "ventana_id", "vendedor_id") WHERE multiplier_id IS NULL;
