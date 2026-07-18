-- Existing ADMIN and MODERATOR users retain their password hashes and may leave
-- Apple identity fields null. Existing sightings remain unowned until explicitly
-- associated with an observer.
ALTER TYPE "UserRole" ADD VALUE 'OBSERVER';

ALTER TABLE "users"
  ALTER COLUMN "email" DROP NOT NULL,
  ALTER COLUMN "password_hash" DROP NOT NULL,
  ADD COLUMN "apple_sub" TEXT,
  ADD COLUMN "display_name" TEXT,
  ADD COLUMN "apple_refresh_token_ciphertext" TEXT,
  ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "sightings"
  ADD COLUMN     "observer_user_id" TEXT;

CREATE TABLE "submission_idempotencies" (
  "id" TEXT NOT NULL,
  "key_hash" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "user_id" TEXT,
  "sighting_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "submission_idempotencies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_apple_sub_key" ON "users"("apple_sub");
CREATE INDEX "sightings_observer_user_id_observed_at_id_idx"
  ON "sightings"("observer_user_id", "observed_at" DESC, "id" DESC);
CREATE UNIQUE INDEX "submission_idempotencies_key_hash_key"
  ON "submission_idempotencies"("key_hash");
CREATE INDEX "submission_idempotencies_user_id_created_at_idx"
  ON "submission_idempotencies"("user_id", "created_at" DESC);

ALTER TABLE "sightings"
  ADD CONSTRAINT "sightings_observer_user_id_fkey"
  FOREIGN KEY ("observer_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "submission_idempotencies"
  ADD CONSTRAINT "submission_idempotencies_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "submission_idempotencies"
  ADD CONSTRAINT "submission_idempotencies_sighting_id_fkey"
  FOREIGN KEY ("sighting_id") REFERENCES "sightings"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
