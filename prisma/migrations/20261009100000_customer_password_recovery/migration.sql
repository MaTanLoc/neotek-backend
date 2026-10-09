-- Additive customer-only recovery state. No CMS or Booking data is rewritten.
BEGIN;
ALTER TABLE "CustomerAccount" ADD COLUMN "authVersion" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "CustomerPasswordReset" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "tokenHash" VARCHAR(64) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "usedAt" TIMESTAMPTZ(3),
  "revokedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerPasswordReset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerPasswordReset_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CustomerPasswordReset_tokenHash_key" ON "CustomerPasswordReset"("tokenHash");
CREATE INDEX "CustomerPasswordReset_customerId_createdAt_idx" ON "CustomerPasswordReset"("customerId", "createdAt");
CREATE INDEX "CustomerPasswordReset_expiresAt_idx" ON "CustomerPasswordReset"("expiresAt");
ALTER TABLE "NotificationDelivery" ADD COLUMN "passwordResetId" TEXT;
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_passwordResetId_fkey" FOREIGN KEY ("passwordResetId") REFERENCES "CustomerPasswordReset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerAccount" ADD CONSTRAINT "CustomerAccount_auth_version" CHECK ("authVersion" >= 0);
ALTER TABLE "CustomerPasswordReset" ADD CONSTRAINT "CustomerPasswordReset_valid_token"
  CHECK ("tokenHash" ~ '^[0-9a-f]{64}$' AND "expiresAt" > "createdAt");
-- Extend the existing outbox shape without relaxing verification/booking rules.
ALTER TABLE "NotificationDelivery" DROP CONSTRAINT "NotificationDelivery_shape";
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_shape"
  CHECK ("attempts" >= 0 AND "attempts" <= 5 AND "locale" IN ('vi', 'en')
    AND (("verificationId" IS NOT NULL AND "passwordResetId" IS NULL AND "bookingId" IS NULL AND "eventId" IS NULL)
      OR ("verificationId" IS NULL AND "passwordResetId" IS NOT NULL AND "bookingId" IS NULL AND "eventId" IS NULL)
      OR ("verificationId" IS NULL AND "passwordResetId" IS NULL AND "bookingId" IS NOT NULL AND "eventId" IS NOT NULL))
    AND (("status" = 'PROCESSING' AND "lockToken" IS NOT NULL AND "lockedAt" IS NOT NULL)
      OR ("status" <> 'PROCESSING' AND "lockToken" IS NULL AND "lockedAt" IS NULL)));
COMMIT;
