-- Existing accounts and Google sign-in can have no phone number.
-- Email registration requires a phone number through API validation.
ALTER TABLE "CustomerAccount" ADD COLUMN "phone" VARCHAR(32);
