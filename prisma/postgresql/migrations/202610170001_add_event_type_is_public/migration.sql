-- Hide the studio's internal "Quick appointment" service from the client-facing booking page. The
-- baseline already carries this column; this migration is for databases deployed before it and is
-- safe to re-run.
ALTER TABLE "EventType" ADD COLUMN IF NOT EXISTS "isPublic" boolean NOT NULL DEFAULT true;
