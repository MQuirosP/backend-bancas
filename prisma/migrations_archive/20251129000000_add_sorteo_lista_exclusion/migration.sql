-- CreateTable
CREATE TABLE "sorteo_lista_exclusion" (
    "id" UUID NOT NULL,
    "sorteo_id" UUID NOT NULL,
    "ventana_id" UUID NOT NULL,
    "vendedor_id" UUID,
    "excluded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "excluded_by" UUID NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sorteo_lista_exclusion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sorteo_lista_exclusion_sorteo_id_idx" ON "sorteo_lista_exclusion"("sorteo_id");

-- CreateIndex
CREATE INDEX "sorteo_lista_exclusion_ventana_id_idx" ON "sorteo_lista_exclusion"("ventana_id");

-- CreateIndex
CREATE INDEX "sorteo_lista_exclusion_vendedor_id_idx" ON "sorteo_lista_exclusion"("vendedor_id");

-- CreateIndex
CREATE UNIQUE INDEX "sorteo_lista_exclusion_sorteo_id_ventana_id_vendedor_id_key" ON "sorteo_lista_exclusion"("sorteo_id", "ventana_id", "vendedor_id");

-- AddForeignKey
ALTER TABLE "sorteo_lista_exclusion" ADD CONSTRAINT "sorteo_lista_exclusion_sorteo_id_fkey" FOREIGN KEY ("sorteo_id") REFERENCES "Sorteo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sorteo_lista_exclusion" ADD CONSTRAINT "sorteo_lista_exclusion_ventana_id_fkey" FOREIGN KEY ("ventana_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sorteo_lista_exclusion" ADD CONSTRAINT "sorteo_lista_exclusion_vendedor_id_fkey" FOREIGN KEY ("vendedor_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sorteo_lista_exclusion" ADD CONSTRAINT "sorteo_lista_exclusion_excluded_by_fkey" FOREIGN KEY ("excluded_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
