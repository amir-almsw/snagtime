-- Hide the studio's internal "Quick appointment" service from the client-facing booking page
-- (book.dvision.studio). isPublic defaults to true, so existing services stay public.

-- AlterTable
ALTER TABLE "EventType" ADD COLUMN "isPublic" BOOLEAN NOT NULL DEFAULT true;
