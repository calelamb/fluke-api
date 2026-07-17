-- CreateTable
CREATE TABLE "external_sightings" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "species" TEXT NOT NULL,
    "ecotype_guess" "Ecotype",
    "group_size" INTEGER,
    "attribution" TEXT NOT NULL,
    "source_url" TEXT,
    "notes" TEXT,
    "trusted" BOOLEAN NOT NULL DEFAULT false,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_sightings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "external_sightings_observed_at_idx" ON "external_sightings"("observed_at" DESC);

-- CreateIndex
CREATE INDEX "external_sightings_latitude_longitude_idx" ON "external_sightings"("latitude", "longitude");

-- CreateIndex
CREATE UNIQUE INDEX "external_sightings_source_external_id_key" ON "external_sightings"("source", "external_id");
