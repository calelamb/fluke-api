-- Enforce the five-photo product limit under concurrent uploads. The unique
-- index serializes contenders for the same slot; the check bounds all slots.
ALTER TABLE "sighting_photos"
ADD CONSTRAINT "sighting_photos_order_index_range"
CHECK ("order_index" BETWEEN 0 AND 4);

CREATE UNIQUE INDEX "sighting_photos_sighting_id_order_index_key"
ON "sighting_photos"("sighting_id", "order_index");
