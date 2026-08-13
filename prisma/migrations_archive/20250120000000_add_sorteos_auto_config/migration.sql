-- CreateTable
CREATE TABLE "SorteosAutoConfig" (
    "id" UUID NOT NULL,
    "autoOpenEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoCreateEnabled" BOOLEAN NOT NULL DEFAULT false,
    "openCronSchedule" TEXT,
    "createCronSchedule" TEXT,
    "lastOpenExecution" TIMESTAMP(3),
    "lastCreateExecution" TIMESTAMP(3),
    "lastOpenCount" INTEGER,
    "lastCreateCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" UUID,

    CONSTRAINT "SorteosAutoConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SorteosAutoConfig_id_key" ON "SorteosAutoConfig"("id");

-- AddForeignKey
ALTER TABLE "SorteosAutoConfig" ADD CONSTRAINT "SorteosAutoConfig_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

