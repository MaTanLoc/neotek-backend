CREATE TYPE "PageKind" AS ENUM ('STANDARD', 'SOLUTION_DETAIL');
ALTER TABLE "Page" ADD COLUMN "kind" "PageKind" NOT NULL DEFAULT 'STANDARD';
CREATE INDEX "Page_kind_status_idx" ON "Page"("kind", "status");
