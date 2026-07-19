-- Release artifacts are registered once. Only their explicit lifecycle fields
-- may change after insertion; identity, evidence, inventory, and publication
-- metadata remain permanently auditable.
CREATE FUNCTION "identifier_release_metadata_is_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."manifest_version" IS DISTINCT FROM NEW."manifest_version"
    OR OLD."sequence" IS DISTINCT FROM NEW."sequence"
    OR OLD."model_id" IS DISTINCT FROM NEW."model_id"
    OR OLD."model_version" IS DISTINCT FROM NEW."model_version"
    OR OLD."index_version" IS DISTINCT FROM NEW."index_version"
    OR OLD."rights_attestation_digest" IS DISTINCT FROM NEW."rights_attestation_digest"
    OR OLD."score_semantics" IS DISTINCT FROM NEW."score_semantics"
    OR OLD."catalog_inventory" IS DISTINCT FROM NEW."catalog_inventory"
    OR OLD."published_at" IS DISTINCT FROM NEW."published_at"
  THEN
    RAISE EXCEPTION 'identifier release metadata is immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "identifier_release_metadata_is_immutable"
BEFORE UPDATE ON "identifier_releases"
FOR EACH ROW EXECUTE FUNCTION "identifier_release_metadata_is_immutable"();
