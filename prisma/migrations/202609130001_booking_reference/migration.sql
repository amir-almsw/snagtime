-- Client-facing booking reference. Hand written rather than generated: `prisma migrate dev` wants to
-- redefine eleven unrelated tables to close pre-existing drift between schema.prisma and this history,
-- and rebuilding AuthSession breaks the OAuthState workspace-guard trigger mid-migration.
--
-- A nullable column needs no table rebuild in SQLite, and a unique index over it still permits many
-- NULLs -- which is what the fixture rows that predate this column are.
ALTER TABLE "Booking" ADD COLUMN "reference" TEXT;
CREATE UNIQUE INDEX "Booking_reference_key" ON "Booking"("reference");
