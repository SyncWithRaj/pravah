-- CreateEnum
CREATE TYPE "EdgeNodeStatus" AS ENUM ('HEALTHY', 'DEGRADED', 'DOWN');

-- CreateEnum
CREATE TYPE "ReplicationJobStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETE', 'FAILED');

-- AlterTable
ALTER TABLE "file_versions" ADD COLUMN     "isCompressed" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "edge_nodes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "endpointUrl" TEXT NOT NULL,
    "status" "EdgeNodeStatus" NOT NULL DEFAULT 'HEALTHY',
    "lastHeartbeat" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "edge_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "replication_status" (
    "id" TEXT NOT NULL,
    "status" "ReplicationJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "fileId" TEXT NOT NULL,
    "edgeNodeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "replication_status_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "edge_nodes_name_key" ON "edge_nodes"("name");

-- CreateIndex
CREATE INDEX "edge_nodes_status_idx" ON "edge_nodes"("status");

-- CreateIndex
CREATE INDEX "edge_nodes_region_idx" ON "edge_nodes"("region");

-- CreateIndex
CREATE INDEX "replication_status_fileId_idx" ON "replication_status"("fileId");

-- CreateIndex
CREATE INDEX "replication_status_edgeNodeId_idx" ON "replication_status"("edgeNodeId");

-- CreateIndex
CREATE INDEX "replication_status_status_idx" ON "replication_status"("status");

-- CreateIndex
CREATE UNIQUE INDEX "replication_status_fileId_edgeNodeId_key" ON "replication_status"("fileId", "edgeNodeId");

-- AddForeignKey
ALTER TABLE "replication_status" ADD CONSTRAINT "replication_status_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replication_status" ADD CONSTRAINT "replication_status_edgeNodeId_fkey" FOREIGN KEY ("edgeNodeId") REFERENCES "edge_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
