ALTER TABLE "Booking" ADD COLUMN "externalCalendarEventId" VARCHAR(128);

CREATE TABLE "OrganizerCredential" (
  "id" VARCHAR(80) NOT NULL,
  "email" VARCHAR(320) NOT NULL,
  "clientId" VARCHAR(320) NOT NULL,
  "encryptedRefreshToken" TEXT NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "OrganizerCredential_pkey" PRIMARY KEY ("id")
);
