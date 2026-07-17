-- CreateEnum
CREATE TYPE "JobRunEventType" AS ENUM (
    'STARTED',
    'SUCCEEDED',
    'FAILED',
    'SKIPPED_LOCKED',
    'LEASE_LOST'
);

-- CreateTable
CREATE TABLE "job_leases" (
    "job_name" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "owner_token" TEXT NOT NULL,
    "fence" BIGINT NOT NULL,
    "acquired_at" TIMESTAMP(3) NOT NULL,
    "heartbeat_at" TIMESTAMP(3) NOT NULL,
    "lease_expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_leases_pkey" PRIMARY KEY ("job_name")
);

-- CreateTable
CREATE TABLE "job_run_events" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "job_name" TEXT NOT NULL,
    "event" "JobRunEventType" NOT NULL,
    "fence" BIGINT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "summary" JSONB,
    "error_code" TEXT,

    CONSTRAINT "job_run_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_run_events_run_id_event_key"
ON "job_run_events"("run_id", "event");

-- CreateIndex
CREATE INDEX "job_run_events_job_name_occurred_at_idx"
ON "job_run_events"("job_name", "occurred_at" DESC);

-- Append-only audit protection
CREATE FUNCTION "job_run_events_are_append_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'job_run_events are append-only';
END;
$$;

CREATE TRIGGER "job_run_events_are_append_only"
BEFORE UPDATE OR DELETE ON "job_run_events"
FOR EACH ROW EXECUTE FUNCTION "job_run_events_are_append_only"();
