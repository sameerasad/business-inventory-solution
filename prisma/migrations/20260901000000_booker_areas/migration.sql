-- Territory: which areas each booker is responsible for.
--
-- Many-to-many, because a booker covers several areas and a large area is
-- sometimes split between two bookers. Cascade on both sides: an assignment is
-- meaningless without the booker or the area it joins, and unlike a booking it
-- carries no history worth keeping once either end is gone for good.
CREATE TABLE "booker_areas" (
    "booker_id"   INTEGER NOT NULL,
    "area_id"     INTEGER NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booker_areas_pkey" PRIMARY KEY ("booker_id", "area_id")
);

-- The reverse lookup ("who covers this area?") is as common as the forward one.
CREATE INDEX "booker_areas_area_id_idx" ON "booker_areas"("area_id");

ALTER TABLE "booker_areas"
    ADD CONSTRAINT "booker_areas_booker_id_fkey"
    FOREIGN KEY ("booker_id") REFERENCES "bookers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "booker_areas"
    ADD CONSTRAINT "booker_areas_area_id_fkey"
    FOREIGN KEY ("area_id") REFERENCES "areas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
