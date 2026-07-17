-- CreateEnum
CREATE TYPE "PhotoQuality" AS ENUM ('USABLE', 'OCCLUDED', 'MOTION_BLUR', 'WRONG_ANGLE', 'TOO_DISTANT', 'NOT_ORCA');

-- AlterTable
ALTER TABLE "sighting_photos" ADD COLUMN     "done" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "photo_annotations" (
    "id" TEXT NOT NULL,
    "photo_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "quality" "PhotoQuality" NOT NULL,
    "payload" JSONB NOT NULL,
    "whale_id" TEXT,
    "confidence" "IdConfidence",
    "notes" TEXT,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "labeled_by" TEXT NOT NULL,
    "labeled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photo_annotations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "photo_annotations_photo_id_version_idx" ON "photo_annotations"("photo_id", "version" DESC);

-- CreateIndex
CREATE INDEX "photo_annotations_done_idx" ON "photo_annotations"("done");

-- CreateIndex
CREATE INDEX "photo_annotations_whale_id_idx" ON "photo_annotations"("whale_id");

-- CreateIndex
CREATE UNIQUE INDEX "photo_annotations_photo_id_version_key" ON "photo_annotations"("photo_id", "version");

-- CreateIndex
CREATE INDEX "sighting_photos_done_idx" ON "sighting_photos"("done");

-- AddForeignKey
ALTER TABLE "photo_annotations" ADD CONSTRAINT "photo_annotations_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "sighting_photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_annotations" ADD CONSTRAINT "photo_annotations_whale_id_fkey" FOREIGN KEY ("whale_id") REFERENCES "whales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_annotations" ADD CONSTRAINT "photo_annotations_labeled_by_fkey" FOREIGN KEY ("labeled_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
