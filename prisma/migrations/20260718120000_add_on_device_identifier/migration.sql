-- Identifier releases are server-published catalog artifacts. Suggestions retain
-- only canonical server identifiers and bounded match evidence for moderation.
CREATE TYPE "IdentifierReleaseStatus" AS ENUM ('ACTIVE', 'ACCEPTED', 'REVOKED');
CREATE TYPE "IdentificationSuggestionStatus" AS ENUM (
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'INVALIDATED'
);

CREATE TABLE "identifier_releases" (
  "manifest_version" TEXT NOT NULL,
  "sequence" BIGINT NOT NULL,
  "model_id" TEXT NOT NULL,
  "model_version" TEXT NOT NULL,
  "index_version" TEXT NOT NULL,
  "rights_attestation_digest" TEXT NOT NULL,
  "score_semantics" TEXT NOT NULL,
  "catalog_inventory" JSONB NOT NULL,
  "status" "IdentifierReleaseStatus" NOT NULL,
  "published_at" TIMESTAMP(3) NOT NULL,
  "suggestions_accepted_until" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),

  CONSTRAINT "identifier_releases_pkey" PRIMARY KEY ("manifest_version")
);

CREATE TABLE "sighting_identification_suggestions" (
  "id" TEXT NOT NULL,
  "sighting_id" TEXT NOT NULL,
  "whale_id" TEXT NOT NULL,
  "release_manifest_version" TEXT NOT NULL,
  "similarity_score" DECIMAL(8,7) NOT NULL,
  "score_semantics" TEXT NOT NULL,
  "matched_reference_photo_ids" JSONB NOT NULL,
  "status" "IdentificationSuggestionStatus" NOT NULL DEFAULT 'PENDING',
  "reviewed_by_id" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "sighting_identification_suggestions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "identifier_releases_sequence_key"
ON "identifier_releases"("sequence");

CREATE UNIQUE INDEX "identifier_releases_one_active"
ON "identifier_releases" ((status)) WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX "sighting_identification_suggestions_sighting_id_key"
ON "sighting_identification_suggestions"("sighting_id");

ALTER TABLE "sighting_identification_suggestions"
  ADD CONSTRAINT "sighting_identification_suggestions_sighting_id_fkey"
  FOREIGN KEY ("sighting_id") REFERENCES "sightings"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sighting_identification_suggestions"
  ADD CONSTRAINT "sighting_identification_suggestions_whale_id_fkey"
  FOREIGN KEY ("whale_id") REFERENCES "whales"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sighting_identification_suggestions"
  ADD CONSTRAINT "sighting_identification_suggestions_release_manifest_version_fkey"
  FOREIGN KEY ("release_manifest_version") REFERENCES "identifier_releases"("manifest_version")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sighting_identification_suggestions"
  ADD CONSTRAINT "sighting_identification_suggestions_reviewed_by_id_fkey"
  FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
