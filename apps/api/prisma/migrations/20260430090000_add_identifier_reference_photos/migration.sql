-- CreateEnum
CREATE TYPE "ReferencePhotoSide" AS ENUM ('LEFT', 'RIGHT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "EmbeddingStatus" AS ENUM ('PENDING', 'EMBEDDED', 'FAILED');

-- CreateTable
CREATE TABLE "whale_reference_photos" (
    "id" TEXT NOT NULL,
    "whale_id" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "side" "ReferencePhotoSide" NOT NULL DEFAULT 'UNKNOWN',
    "quality" "PhotoQuality" NOT NULL DEFAULT 'USABLE',
    "crop_x" DOUBLE PRECISION,
    "crop_y" DOUBLE PRECISION,
    "crop_width" DOUBLE PRECISION,
    "crop_height" DOUBLE PRECISION,
    "embedding_status" "EmbeddingStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whale_reference_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identification_attempts" (
    "id" TEXT NOT NULL,
    "upload_key" TEXT NOT NULL,
    "upload_url" TEXT NOT NULL,
    "result_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identification_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whale_reference_photos_whale_id_idx" ON "whale_reference_photos"("whale_id");

-- CreateIndex
CREATE INDEX "whale_reference_photos_embedding_status_idx" ON "whale_reference_photos"("embedding_status");

-- CreateIndex
CREATE INDEX "identification_attempts_created_at_idx" ON "identification_attempts"("created_at" DESC);

-- AddForeignKey
ALTER TABLE "whale_reference_photos" ADD CONSTRAINT "whale_reference_photos_whale_id_fkey" FOREIGN KEY ("whale_id") REFERENCES "whales"("id") ON DELETE CASCADE ON UPDATE CASCADE;
