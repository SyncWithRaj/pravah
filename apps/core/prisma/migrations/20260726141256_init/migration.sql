-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "FileStatus" AS ENUM ('PENDING', 'UPLOADING', 'ASSEMBLING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ChunkStatus" AS ENUM ('PENDING', 'UPLOADED', 'VERIFIED');

-- CreateEnum
CREATE TYPE "TranscodeStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "TranscodeQuality" AS ENUM ('Q_1080P', 'Q_720P', 'Q_480P', 'Q_360P');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "totalSize" BIGINT NOT NULL,
    "totalChunks" INTEGER NOT NULL,
    "uploadedChunks" INTEGER NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "status" "FileStatus" NOT NULL DEFAULT 'PENDING',
    "bucketName" TEXT NOT NULL DEFAULT 'pravah-origin',
    "storagePath" TEXT,
    "ownerId" TEXT NOT NULL,
    "currentVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_chunks" (
    "id" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "size" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "status" "ChunkStatus" NOT NULL DEFAULT 'PENDING',
    "fileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_versions" (
    "id" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,
    "changeNote" TEXT,
    "fileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_transcodes" (
    "id" TEXT NOT NULL,
    "quality" "TranscodeQuality" NOT NULL,
    "status" "TranscodeStatus" NOT NULL DEFAULT 'PENDING',
    "storagePath" TEXT,
    "masterPlaylistPath" TEXT,
    "durationSeconds" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "bitrateKbps" INTEGER,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "fileId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_transcodes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "files_currentVersionId_key" ON "files"("currentVersionId");

-- CreateIndex
CREATE INDEX "files_ownerId_idx" ON "files"("ownerId");

-- CreateIndex
CREATE INDEX "files_status_idx" ON "files"("status");

-- CreateIndex
CREATE INDEX "file_chunks_fileId_idx" ON "file_chunks"("fileId");

-- CreateIndex
CREATE INDEX "file_chunks_fileId_status_idx" ON "file_chunks"("fileId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "file_chunks_fileId_chunkIndex_key" ON "file_chunks"("fileId", "chunkIndex");

-- CreateIndex
CREATE INDEX "file_versions_fileId_idx" ON "file_versions"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "file_versions_fileId_versionNumber_key" ON "file_versions"("fileId", "versionNumber");

-- CreateIndex
CREATE INDEX "video_transcodes_fileId_idx" ON "video_transcodes"("fileId");

-- CreateIndex
CREATE INDEX "video_transcodes_versionId_idx" ON "video_transcodes"("versionId");

-- CreateIndex
CREATE INDEX "video_transcodes_status_idx" ON "video_transcodes"("status");

-- CreateIndex
CREATE UNIQUE INDEX "video_transcodes_fileId_versionId_quality_key" ON "video_transcodes"("fileId", "versionId", "quality");

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "file_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_transcodes" ADD CONSTRAINT "video_transcodes_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_transcodes" ADD CONSTRAINT "video_transcodes_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "file_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
