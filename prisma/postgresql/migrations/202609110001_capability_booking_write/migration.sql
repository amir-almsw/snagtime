-- Client-initiated cancel and reschedule were failing closed in production. Both run in capability mode
-- under action 'booking_write', and BookingRecoveryToken carried no policy for that action: the token
-- reissue inside enqueueBookingEmail() raised "new row violates row-level security policy" and the route
-- answered 500, while the predecessor revoke and the reminder supersede matched no rows at all -- silently,
-- because an UPDATE that filters everything out is not an error. The baseline now carries these policies;
-- this migration is for databases already deployed without them. DROP ... IF EXISTS first so it is
-- idempotent and safe to apply twice.
DROP POLICY IF EXISTS app_capability_recovery_write ON "BookingRecoveryToken";
DROP POLICY IF EXISTS app_capability_recovery_revoke ON "BookingRecoveryToken";
DROP POLICY IF EXISTS app_capability_recovery_read ON "BookingRecoveryToken";
DROP POLICY IF EXISTS app_capability_email_supersede ON "EmailOutbox";

CREATE POLICY app_capability_recovery_write ON "BookingRecoveryToken" FOR INSERT TO tempocove_app WITH CHECK (
  current_setting('tempocove.action',true)='booking_write' AND tempocove_capability_booking("bookingId")
  AND EXISTS(SELECT 1 FROM "Booking" b WHERE b.id="BookingRecoveryToken"."bookingId" AND b."workspaceId"="BookingRecoveryToken"."workspaceId" AND lower(b."inviteeEmail")=lower("BookingRecoveryToken".email)));
CREATE POLICY app_capability_recovery_revoke ON "BookingRecoveryToken" FOR UPDATE TO tempocove_app
USING (current_setting('tempocove.action',true)='booking_write' AND tempocove_capability_booking("bookingId"))
WITH CHECK (current_setting('tempocove.action',true)='booking_write' AND tempocove_capability_booking("bookingId"));
-- Paired with the INSERT for the same reason app_capability_email_read is paired with
-- app_capability_email: Prisma writes with RETURNING, and PostgreSQL applies SELECT policies to the
-- rows an INSERT returns, so without this the statement still fails with the identical message.
CREATE POLICY app_capability_recovery_read ON "BookingRecoveryToken" FOR SELECT TO tempocove_app
USING (current_setting('tempocove.action',true)='booking_write' AND tempocove_capability_booking("bookingId"));
CREATE POLICY app_capability_email_supersede ON "EmailOutbox" FOR UPDATE TO tempocove_app
USING (current_setting('tempocove.action',true)='booking_write' AND "bookingId" IS NOT NULL AND tempocove_capability_booking("bookingId"))
WITH CHECK (current_setting('tempocove.action',true)='booking_write' AND "bookingId" IS NOT NULL AND tempocove_capability_booking("bookingId"));
