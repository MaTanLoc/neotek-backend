ALTER TABLE "CustomerAccount" ALTER COLUMN "passwordHash" DROP NOT NULL;

CREATE TABLE "CustomerOAuthIdentity" (
  "id" TEXT NOT NULL,
  "provider" VARCHAR(20) NOT NULL,
  "providerSubject" VARCHAR(255) NOT NULL,
  "customerId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerOAuthIdentity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerOAuthIdentity_provider_check" CHECK ("provider" = 'GOOGLE'),
  CONSTRAINT "CustomerOAuthIdentity_subject_check" CHECK (length("providerSubject") > 0),
  CONSTRAINT "CustomerOAuthIdentity_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CustomerOAuthIdentity_provider_providerSubject_key" ON "CustomerOAuthIdentity"("provider", "providerSubject");
CREATE UNIQUE INDEX "CustomerOAuthIdentity_customerId_provider_key" ON "CustomerOAuthIdentity"("customerId", "provider");
