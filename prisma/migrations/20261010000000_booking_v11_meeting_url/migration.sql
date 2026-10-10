BEGIN;

ALTER TABLE "Booking" ADD COLUMN "meetingUrl" VARCHAR(200);

-- Retain the legacy enum/audit values without rewriting historical records.
-- New workflow transitions support only the four V1.1 states.
CREATE OR REPLACE FUNCTION "check_booking_status_transition"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'PENDING' AND NEW."status" IN ('CONFIRMED', 'CANCELLED'))
    OR (OLD."status" = 'CONFIRMED' AND NEW."status" IN ('COMPLETED', 'CANCELLED')))
  THEN RAISE EXCEPTION 'Invalid booking status transition' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'CONFIRMED' AND OLD."status" <> 'CONFIRMED' AND (
    NEW."meetingUrl" IS NULL OR NEW."meetingUrl" !~ '^https://meet[.]google[.]com/[a-z]{3}-[a-z]{4}-[a-z]{3}$')
  THEN RAISE EXCEPTION 'Valid Google Meet URL required' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" <> 'PENDING' AND NEW."meetingUrl" IS DISTINCT FROM OLD."meetingUrl"
  THEN RAISE EXCEPTION 'Meeting URL is read-only after confirmation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
