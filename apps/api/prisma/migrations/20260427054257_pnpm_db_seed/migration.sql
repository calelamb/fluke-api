-- CreateEnum
CREATE TYPE "Ecotype" AS ENUM ('RESIDENT', 'BIGGS', 'OFFSHORE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "Sex" AS ENUM ('MALE', 'FEMALE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "WhaleStatus" AS ENUM ('ALIVE', 'DECEASED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SightingStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "IdConfidence" AS ENUM ('CONFIRMED', 'LIKELY', 'ML_SUGGESTED');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MODERATOR');

-- CreateTable
CREATE TABLE "whales" (
    "id" TEXT NOT NULL,
    "catalog_id" TEXT NOT NULL,
    "name" TEXT,
    "ecotype" "Ecotype" NOT NULL,
    "pod" TEXT,
    "sex" "Sex" NOT NULL DEFAULT 'UNKNOWN',
    "birth_year" INTEGER,
    "death_year" INTEGER,
    "status" "WhaleStatus" NOT NULL DEFAULT 'UNKNOWN',
    "mother_id" TEXT,
    "biography" TEXT,
    "distinguishing_marks" TEXT,
    "hero_image_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sightings" (
    "id" TEXT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "location_name" TEXT,
    "ecotype_guess" "Ecotype",
    "group_size" INTEGER,
    "behavior_notes" TEXT,
    "observer_name" TEXT,
    "observer_email" TEXT NOT NULL,
    "status" "SightingStatus" NOT NULL DEFAULT 'PENDING',
    "rejection_reason" TEXT,
    "moderated_by" TEXT,
    "moderated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sightings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sighting_photos" (
    "id" TEXT NOT NULL,
    "sighting_id" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "thumbnail_url" TEXT NOT NULL,
    "order_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sighting_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sighting_whales" (
    "sighting_id" TEXT NOT NULL,
    "whale_id" TEXT NOT NULL,
    "confidence" "IdConfidence" NOT NULL,
    "ml_score" DOUBLE PRECISION,

    CONSTRAINT "sighting_whales_pkey" PRIMARY KEY ("sighting_id","whale_id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'MODERATOR',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whales_catalog_id_key" ON "whales"("catalog_id");

-- CreateIndex
CREATE INDEX "whales_ecotype_pod_idx" ON "whales"("ecotype", "pod");

-- CreateIndex
CREATE INDEX "sightings_status_observed_at_idx" ON "sightings"("status", "observed_at" DESC);

-- CreateIndex
CREATE INDEX "sightings_latitude_longitude_idx" ON "sightings"("latitude", "longitude");

-- CreateIndex
CREATE INDEX "sighting_whales_whale_id_idx" ON "sighting_whales"("whale_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "audit_log_user_id_created_at_idx" ON "audit_log"("user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "whales" ADD CONSTRAINT "whales_mother_id_fkey" FOREIGN KEY ("mother_id") REFERENCES "whales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sightings" ADD CONSTRAINT "sightings_moderated_by_fkey" FOREIGN KEY ("moderated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sighting_photos" ADD CONSTRAINT "sighting_photos_sighting_id_fkey" FOREIGN KEY ("sighting_id") REFERENCES "sightings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sighting_whales" ADD CONSTRAINT "sighting_whales_sighting_id_fkey" FOREIGN KEY ("sighting_id") REFERENCES "sightings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sighting_whales" ADD CONSTRAINT "sighting_whales_whale_id_fkey" FOREIGN KEY ("whale_id") REFERENCES "whales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
