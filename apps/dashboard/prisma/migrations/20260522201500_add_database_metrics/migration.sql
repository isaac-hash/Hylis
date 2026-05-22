-- CreateTable
CREATE TABLE "DatabaseMetric" (
    "id" TEXT NOT NULL,
    "databaseId" TEXT NOT NULL,
    "connections" INTEGER NOT NULL DEFAULT 0,
    "queryThroughput" BIGINT NOT NULL DEFAULT 0,
    "slowQueryCount" INTEGER NOT NULL DEFAULT 0,
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatabaseMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DatabaseMetric_databaseId_createdAt_idx" ON "DatabaseMetric"("databaseId", "createdAt");

-- AddForeignKey
ALTER TABLE "DatabaseMetric" ADD CONSTRAINT "DatabaseMetric_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "Database"("id") ON DELETE CASCADE ON UPDATE CASCADE;
