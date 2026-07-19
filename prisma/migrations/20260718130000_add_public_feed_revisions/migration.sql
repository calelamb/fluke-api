CREATE SEQUENCE "public_feed_revision_seq" AS BIGINT;

ALTER TABLE "sightings"
ADD COLUMN "public_feed_revision" BIGINT;

ALTER TABLE "external_sightings"
ADD COLUMN "public_feed_revision" BIGINT,
ADD COLUMN "public_feed_removed_at" TIMESTAMP(3),
ADD COLUMN "first_fetched_at" TIMESTAMP(3),
ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE FUNCTION "next_public_feed_revision"()
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
BEGIN
  -- Sequence values are not rolled back. The transaction-scoped lock also
  -- prevents a later revision from committing before an earlier assignment.
  PERFORM pg_advisory_xact_lock(731864212);
  RETURN nextval('public_feed_revision_seq');
END;
$$;

UPDATE "external_sightings"
SET "first_fetched_at" = "fetched_at"
WHERE "first_fetched_at" IS NULL;

WITH "backfill" AS (
  SELECT "id", "next_public_feed_revision"() AS "revision"
  FROM "sightings"
  WHERE "status" = 'APPROVED'
  ORDER BY "observed_at", "id"
)
UPDATE "sightings" AS "sighting"
SET "public_feed_revision" = "backfill"."revision"
FROM "backfill"
WHERE "sighting"."id" = "backfill"."id";

WITH "backfill" AS (
  SELECT "id", "next_public_feed_revision"() AS "revision"
  FROM "external_sightings"
  ORDER BY "observed_at", "id"
)
UPDATE "external_sightings" AS "sighting"
SET "public_feed_revision" = "backfill"."revision"
FROM "backfill"
WHERE "sighting"."id" = "backfill"."id";

CREATE FUNCTION "revise_public_sighting"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" = 'APPROVED' THEN
      NEW."public_feed_revision" = "next_public_feed_revision"();
    ELSE
      NEW."public_feed_revision" = NULL;
    END IF;
  ELSE
    IF (
      (OLD."status" = 'APPROVED') IS DISTINCT FROM (NEW."status" = 'APPROVED')
      OR (
        NEW."status" = 'APPROVED'
        AND ROW(
          OLD."observed_at",
          OLD."latitude",
          OLD."longitude",
          OLD."location_name",
          OLD."ecotype_guess",
          OLD."group_size",
          OLD."behavior_notes"
        ) IS DISTINCT FROM ROW(
          NEW."observed_at",
          NEW."latitude",
          NEW."longitude",
          NEW."location_name",
          NEW."ecotype_guess",
          NEW."group_size",
          NEW."behavior_notes"
        )
      )
      OR (
        OLD."public_feed_revision" IS DISTINCT FROM NEW."public_feed_revision"
        AND pg_trigger_depth() > 1
      )
    ) THEN
      NEW."public_feed_revision" = "next_public_feed_revision"();
    ELSE
      NEW."public_feed_revision" = OLD."public_feed_revision";
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "revise_public_sighting"
BEFORE INSERT OR UPDATE ON "sightings"
FOR EACH ROW EXECUTE FUNCTION "revise_public_sighting"();

CREATE FUNCTION "revise_public_sighting_relation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  "old_sighting_id" TEXT;
  "new_sighting_id" TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'sighting_whales' THEN
      IF ROW(
        OLD."sighting_id",
        OLD."whale_id",
        OLD."confidence"
      ) IS NOT DISTINCT FROM ROW(
        NEW."sighting_id",
        NEW."whale_id",
        NEW."confidence"
      ) THEN
        RETURN NEW;
      END IF;
    ELSIF TG_TABLE_NAME = 'sighting_photos' THEN
      IF ROW(
        OLD."sighting_id",
        OLD."id",
        OLD."url",
        OLD."thumbnail_url",
        OLD."order_index"
      ) IS NOT DISTINCT FROM ROW(
        NEW."sighting_id",
        NEW."id",
        NEW."url",
        NEW."thumbnail_url",
        NEW."order_index"
      ) THEN
        RETURN NEW;
      END IF;
    END IF;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    "old_sighting_id" = OLD."sighting_id";
  END IF;
  IF TG_OP <> 'DELETE' THEN
    "new_sighting_id" = NEW."sighting_id";
  END IF;

  IF "old_sighting_id" IS NOT NULL THEN
    UPDATE "sightings"
    SET "public_feed_revision" = 0
    WHERE "id" = "old_sighting_id" AND "status" = 'APPROVED';
  END IF;
  IF "new_sighting_id" IS NOT NULL
    AND "new_sighting_id" IS DISTINCT FROM "old_sighting_id" THEN
    UPDATE "sightings"
    SET "public_feed_revision" = 0
    WHERE "id" = "new_sighting_id" AND "status" = 'APPROVED';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "revise_public_sighting_photo"
AFTER INSERT OR UPDATE OR DELETE ON "sighting_photos"
FOR EACH ROW EXECUTE FUNCTION "revise_public_sighting_relation"();

CREATE TRIGGER "revise_public_sighting_whale"
AFTER INSERT OR UPDATE OR DELETE ON "sighting_whales"
FOR EACH ROW EXECUTE FUNCTION "revise_public_sighting_relation"();

CREATE FUNCTION "revise_public_sightings_for_whale"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(OLD."catalog_id", OLD."name") IS DISTINCT FROM ROW(NEW."catalog_id", NEW."name") THEN
    UPDATE "sightings" AS "sighting"
    SET "public_feed_revision" = 0
    WHERE "sighting"."status" = 'APPROVED'
      AND EXISTS (
        SELECT 1
        FROM "sighting_whales" AS "link"
        WHERE "link"."sighting_id" = "sighting"."id"
          AND "link"."whale_id" = NEW."id"
      );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "revise_public_sightings_for_whale"
AFTER UPDATE OF "catalog_id", "name" ON "whales"
FOR EACH ROW EXECUTE FUNCTION "revise_public_sightings_for_whale"();

CREATE FUNCTION "revise_external_sighting"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."first_fetched_at" = COALESCE(NEW."first_fetched_at", NEW."fetched_at");
    NEW."updated_at" = CURRENT_TIMESTAMP;
    NEW."public_feed_revision" = "next_public_feed_revision"();
  ELSIF ROW(
    OLD."source",
    OLD."external_id",
    OLD."observed_at",
    OLD."latitude",
    OLD."longitude",
    OLD."species",
    OLD."ecotype_guess",
    OLD."group_size",
    OLD."attribution",
    OLD."source_url",
    OLD."notes",
    OLD."trusted",
    OLD."public_feed_removed_at"
  ) IS DISTINCT FROM ROW(
    NEW."source",
    NEW."external_id",
    NEW."observed_at",
    NEW."latitude",
    NEW."longitude",
    NEW."species",
    NEW."ecotype_guess",
    NEW."group_size",
    NEW."attribution",
    NEW."source_url",
    NEW."notes",
    NEW."trusted",
    NEW."public_feed_removed_at"
  ) THEN
    NEW."updated_at" = CURRENT_TIMESTAMP;
    NEW."public_feed_revision" = "next_public_feed_revision"();
  ELSE
    NEW."updated_at" = OLD."updated_at";
    NEW."public_feed_revision" = OLD."public_feed_revision";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "revise_external_sighting"
BEFORE INSERT OR UPDATE ON "external_sightings"
FOR EACH ROW EXECUTE FUNCTION "revise_external_sighting"();

CREATE INDEX "sightings_public_feed_revision_idx"
ON "sightings"("public_feed_revision");

CREATE INDEX "external_sightings_public_feed_revision_idx"
ON "external_sightings"("public_feed_revision");
