BEGIN;

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "BookingHoldStatus" AS ENUM ('ACTIVE', 'CONVERTED', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ReservationState" AS ENUM ('HOLD', 'BOOKING', 'RELEASED');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'REVOKED');

-- CreateTable
CREATE TABLE "CustomerAccount" (
    "id" TEXT NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "emailVerifiedAt" TIMESTAMPTZ(3),
    "verificationIssuedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CustomerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerEmailVerification" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerEmailVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingResource" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "BookingResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingReservation" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "requestedStartAt" TIMESTAMPTZ(3) NOT NULL,
    "requestedEndAt" TIMESTAMPTZ(3) NOT NULL,
    "busyStartAt" TIMESTAMPTZ(3) NOT NULL,
    "busyEndAt" TIMESTAMPTZ(3) NOT NULL,
    "timezone" VARCHAR(80) NOT NULL,
    "state" "ReservationState" NOT NULL DEFAULT 'HOLD',
    "expiresAt" TIMESTAMPTZ(3),
    "releasedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingHold" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "moduleKey" VARCHAR(120) NOT NULL,
    "solutionLabel" VARCHAR(240) NOT NULL,
    "status" "BookingHoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "idempotencyKey" VARCHAR(80) NOT NULL,
    "requestFingerprint" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BookingHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "holdId" TEXT NOT NULL,
    "contactName" VARCHAR(120) NOT NULL,
    "contactEmail" VARCHAR(254) NOT NULL,
    "contactPhone" VARCHAR(32) NOT NULL,
    "contactCompany" VARCHAR(160) NOT NULL,
    "customerMessage" VARCHAR(2000),
    "moduleKey" VARCHAR(120) NOT NULL,
    "solutionLabel" VARCHAR(240) NOT NULL,
    "locale" VARCHAR(2) NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" VARCHAR(80) NOT NULL,
    "requestFingerprint" VARCHAR(64) NOT NULL,
    "confirmedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingEvent" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "fromStatus" "BookingStatus",
    "toStatus" "BookingStatus",
    "actorUserId" TEXT,
    "reason" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingNote" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "text" VARCHAR(2000) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "deduplicationKey" VARCHAR(240) NOT NULL,
    "customerId" TEXT NOT NULL,
    "verificationId" TEXT,
    "bookingId" TEXT,
    "eventId" TEXT,
    "template" VARCHAR(80) NOT NULL,
    "recipient" VARCHAR(254) NOT NULL,
    "locale" VARCHAR(2) NOT NULL,
    "payload" JSONB NOT NULL,
    "encryptedSecret" TEXT,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMPTZ(3),
    "lockToken" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "lastErrorCode" VARCHAR(80),
    "providerMessageId" VARCHAR(240),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerAccount_email_key" ON "CustomerAccount"("email");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerEmailVerification_tokenHash_key" ON "CustomerEmailVerification"("tokenHash");

-- CreateIndex
CREATE INDEX "CustomerEmailVerification_customerId_createdAt_idx" ON "CustomerEmailVerification"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "CustomerEmailVerification_expiresAt_idx" ON "CustomerEmailVerification"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingResource_key_key" ON "BookingResource"("key");

-- CreateIndex
CREATE INDEX "BookingReservation_resourceId_state_requestedStartAt_idx" ON "BookingReservation"("resourceId", "state", "requestedStartAt");

-- CreateIndex
CREATE INDEX "BookingReservation_customerId_state_idx" ON "BookingReservation"("customerId", "state");

-- CreateIndex
CREATE INDEX "BookingReservation_state_expiresAt_idx" ON "BookingReservation"("state", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingHold_reservationId_key" ON "BookingHold"("reservationId");

-- CreateIndex
CREATE INDEX "BookingHold_customerId_status_idx" ON "BookingHold"("customerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BookingHold_customerId_idempotencyKey_key" ON "BookingHold"("customerId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_reservationId_key" ON "Booking"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_holdId_key" ON "Booking"("holdId");

-- CreateIndex
CREATE INDEX "Booking_customerId_createdAt_id_idx" ON "Booking"("customerId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Booking_status_createdAt_id_idx" ON "Booking"("status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Booking_createdAt_id_idx" ON "Booking"("createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_customerId_idempotencyKey_key" ON "Booking"("customerId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "BookingEvent_bookingId_sequence_key" ON "BookingEvent"("bookingId", "sequence");

-- CreateIndex
CREATE INDEX "BookingNote_bookingId_createdAt_id_idx" ON "BookingNote"("bookingId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_deduplicationKey_key" ON "NotificationDelivery"("deduplicationKey");

-- CreateIndex
CREATE INDEX "NotificationDelivery_status_nextAttemptAt_idx" ON "NotificationDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_customerId_createdAt_idx" ON "NotificationDelivery"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_bookingId_createdAt_idx" ON "NotificationDelivery"("bookingId", "createdAt");

-- AddForeignKey
ALTER TABLE "CustomerEmailVerification" ADD CONSTRAINT "CustomerEmailVerification_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingReservation" ADD CONSTRAINT "BookingReservation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingReservation" ADD CONSTRAINT "BookingReservation_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "BookingResource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingHold" ADD CONSTRAINT "BookingHold_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingHold" ADD CONSTRAINT "BookingHold_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "BookingReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "BookingReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_holdId_fkey" FOREIGN KEY ("holdId") REFERENCES "BookingHold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingEvent" ADD CONSTRAINT "BookingEvent_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingEvent" ADD CONSTRAINT "BookingEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingNote" ADD CONSTRAINT "BookingNote_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingNote" ADD CONSTRAINT "BookingNote_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "CustomerEmailVerification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "BookingEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Custom PostgreSQL invariants, intentionally maintained in migration history.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "CustomerAccount" ADD CONSTRAINT "CustomerAccount_normalized_email"
  CHECK ("email" = lower(btrim("email")) AND length("email") > 0);
ALTER TABLE "CustomerEmailVerification" ADD CONSTRAINT "CustomerEmailVerification_valid_token"
  CHECK ("tokenHash" ~ '^[0-9a-f]{64}$' AND "expiresAt" > "createdAt");
ALTER TABLE "BookingReservation" ADD CONSTRAINT "BookingReservation_valid_interval"
  CHECK ("requestedEndAt" > "requestedStartAt" AND "busyStartAt" <= "requestedStartAt"
    AND "busyEndAt" >= "requestedEndAt");
ALTER TABLE "BookingReservation" ADD CONSTRAINT "BookingReservation_valid_state"
  CHECK (("state" = 'HOLD' AND "expiresAt" IS NOT NULL AND "releasedAt" IS NULL)
    OR ("state" = 'BOOKING' AND "expiresAt" IS NULL AND "releasedAt" IS NULL)
    OR ("state" = 'RELEASED' AND "releasedAt" IS NOT NULL));
ALTER TABLE "BookingReservation" ADD CONSTRAINT "BookingReservation_no_overlap"
  EXCLUDE USING gist ("resourceId" WITH =, tstzrange("busyStartAt", "busyEndAt", '[)') WITH &&)
  WHERE ("state" IN ('HOLD', 'BOOKING'));
CREATE UNIQUE INDEX "BookingReservation_one_hold_per_customer"
  ON "BookingReservation" ("customerId") WHERE ("state" = 'HOLD');
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_contact_fields"
  CHECK (length(btrim("contactName")) > 0 AND length(btrim("contactPhone")) > 0
    AND length(btrim("contactCompany")) > 0 AND length(btrim("moduleKey")) > 0
    AND "locale" IN ('vi', 'en') AND "version" > 0);
ALTER TABLE "BookingEvent" ADD CONSTRAINT "BookingEvent_shape"
  CHECK ("sequence" > 0 AND (
    ("type" = 'CREATED' AND "fromStatus" IS NULL AND "toStatus" IS NOT NULL AND "toStatus" = 'PENDING' AND "actorUserId" IS NULL)
    OR ("type" = 'STATUS_CHANGED' AND "actorUserId" IS NOT NULL AND "fromStatus" IS NOT NULL AND "toStatus" IS NOT NULL AND (
      ("fromStatus" = 'PENDING' AND "toStatus" IN ('CONFIRMED', 'CANCELLED'))
      OR ("fromStatus" = 'CONFIRMED' AND "toStatus" IN ('COMPLETED', 'CANCELLED', 'NO_SHOW'))))
    OR ("type" = 'NOTE_ADDED' AND "actorUserId" IS NOT NULL AND "fromStatus" IS NULL AND "toStatus" IS NULL)));
ALTER TABLE "BookingNote" ADD CONSTRAINT "BookingNote_nonempty" CHECK (length(btrim("text")) > 0);
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_shape"
  CHECK ("attempts" >= 0 AND "attempts" <= 5 AND "locale" IN ('vi', 'en')
    AND (("verificationId" IS NOT NULL AND "bookingId" IS NULL AND "eventId" IS NULL)
      OR ("verificationId" IS NULL AND "bookingId" IS NOT NULL AND "eventId" IS NOT NULL))
    AND (("status" = 'PROCESSING' AND "lockToken" IS NOT NULL AND "lockedAt" IS NOT NULL)
      OR ("status" <> 'PROCESSING' AND "lockToken" IS NULL AND "lockedAt" IS NULL)));

-- Deferred structural checks permit atomic HOLD -> BOOKING conversion while
-- rejecting orphan/mismatched ledger ownership at COMMIT. Time-dependent
-- expiry remains enforced by the locked service transaction, never a CHECK(now()).
CREATE FUNCTION "check_booking_reservation_binding"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  reservation_id text;
  r "BookingReservation"%ROWTYPE;
  h "BookingHold"%ROWTYPE;
  b "Booking"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'BookingReservation' THEN reservation_id := NEW."id";
  ELSE reservation_id := NEW."reservationId";
  END IF;
  SELECT * INTO r FROM "BookingReservation" WHERE "id" = reservation_id;
  SELECT * INTO h FROM "BookingHold" WHERE "reservationId" = reservation_id;
  SELECT * INTO b FROM "Booking" WHERE "reservationId" = reservation_id;
  IF r."id" IS NULL OR h."id" IS NULL OR h."customerId" <> r."customerId"
    OR (b."id" IS NOT NULL AND (b."customerId" <> r."customerId" OR b."holdId" <> h."id"))
    OR (r."state" = 'HOLD' AND (h."status" <> 'ACTIVE' OR b."id" IS NOT NULL))
    OR (r."state" = 'BOOKING' AND (h."status" <> 'CONVERTED' OR b."id" IS NULL OR b."status" = 'CANCELLED'))
    OR (r."state" = 'RELEASED' AND NOT (
      (b."id" IS NULL AND h."status" IN ('EXPIRED', 'RELEASED'))
      OR (b."id" IS NOT NULL AND b."status" = 'CANCELLED' AND h."status" = 'CONVERTED')))
  THEN
    RAISE EXCEPTION 'Invalid booking reservation binding' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "BookingReservation_binding"
  AFTER INSERT OR UPDATE ON "BookingReservation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_booking_reservation_binding"();
CREATE CONSTRAINT TRIGGER "BookingHold_binding"
  AFTER INSERT OR UPDATE ON "BookingHold" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_booking_reservation_binding"();
CREATE CONSTRAINT TRIGGER "Booking_binding"
  AFTER INSERT OR UPDATE ON "Booking" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_booking_reservation_binding"();

CREATE FUNCTION "check_booking_status_transition"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'PENDING' AND NEW."status" IN ('CONFIRMED', 'CANCELLED'))
    OR (OLD."status" = 'CONFIRMED' AND NEW."status" IN ('COMPLETED', 'CANCELLED', 'NO_SHOW')))
  THEN RAISE EXCEPTION 'Invalid booking status transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Booking_status_transition"
  BEFORE UPDATE ON "Booking" FOR EACH ROW EXECUTE FUNCTION "check_booking_status_transition"();

-- Additive deterministic seed: never upsert/update CMS content or operator data.
INSERT INTO "BookingResource" ("id", "key", "name", "active")
  VALUES ('neotek-consultation-v1', 'neotek-consultation', 'NeoTek consultation', true)
  ON CONFLICT ("key") DO NOTHING;

COMMIT;
