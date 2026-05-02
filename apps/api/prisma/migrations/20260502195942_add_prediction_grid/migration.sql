-- CreateTable
CREATE TABLE "prediction_grids" (
    "id" TEXT NOT NULL,
    "subject_kind" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "horizon_hours" INTEGER NOT NULL,
    "cells" JSONB NOT NULL,
    "confidence" DECIMAL(4,3) NOT NULL,
    "model_version" TEXT NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prediction_grids_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "prediction_grids_subject_kind_subject_id_horizon_hours_key" ON "prediction_grids"("subject_kind", "subject_id", "horizon_hours");
