-- Studio booking notices may go to a shared shop mailbox instead of the organizer's sign-in address.
--
-- The three EmailOutbox insert policies pinned the recipient to the invitee or the host's own account
-- address. Routing notices anywhere else was refused by Postgres, which surfaced as a 500 on every
-- booking and cancellation. The allowed address therefore has to be something a policy can see, so it
-- lives on Workspace and is read through a definer: enqueueBookingEmail runs under public booking
-- creation, an organizer session and a client capability link, and no single Workspace SELECT policy
-- spans all three.
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "notificationEmail" TEXT;

CREATE OR REPLACE FUNCTION tempocove_workspace_notification_email(p_workspace_id text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
  SELECT lower(w."notificationEmail") FROM "Workspace" w
  WHERE w."id"=p_workspace_id AND w."notificationEmail" IS NOT NULL AND w."notificationEmail"<>''
$fn$;
ALTER FUNCTION tempocove_workspace_notification_email(text) OWNER TO tempocove_rls_verifier;
REVOKE ALL ON FUNCTION tempocove_workspace_notification_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tempocove_workspace_notification_email(text) TO tempocove_app,tempocove_worker;

DROP POLICY IF EXISTS app_workspace_booking_email_insert ON "EmailOutbox";
CREATE POLICY app_workspace_booking_email_insert ON "EmailOutbox" FOR INSERT TO tempocove_app WITH CHECK (current_setting('tempocove.action',true)='booking_write' AND "bookingId" IS NOT NULL AND tempocove_booking_actor("bookingId") AND status='PENDING' AND "attemptCount"=0 AND "leaseToken" IS NULL AND EXISTS(SELECT 1 FROM "Booking" b JOIN "User" h ON h.id=b."hostId" WHERE b.id="bookingId" AND b."workspaceId"="EmailOutbox"."workspaceId" AND (lower("recipientEmail") IN (lower(b."inviteeEmail"),lower(h.email)) OR lower("recipientEmail")=tempocove_workspace_notification_email(b."workspaceId")) AND ("bookingMutationVersion" IS NULL OR "bookingMutationVersion"=b."mutationVersion")));

DROP POLICY IF EXISTS app_public_email_claim ON "EmailOutbox";
CREATE POLICY app_public_email_claim ON "EmailOutbox" FOR INSERT TO tempocove_app WITH CHECK (current_setting('tempocove.action',true)='booking_create' AND "bookingId" IS NOT NULL AND tempocove_public_booking_claim("bookingId") AND "workspaceId"=current_setting('tempocove.workspace_id',true) AND status='PENDING' AND "attemptCount"=0 AND "leaseToken" IS NULL AND EXISTS(SELECT 1 FROM "Booking" b JOIN "User" h ON h.id=b."hostId" WHERE b.id="bookingId" AND (lower("recipientEmail") IN (lower(b."inviteeEmail"),lower(h.email)) OR lower("recipientEmail")=tempocove_workspace_notification_email(b."workspaceId")) AND ("bookingMutationVersion" IS NULL OR "bookingMutationVersion"=b."mutationVersion")));

DROP POLICY IF EXISTS app_provider_email ON "EmailOutbox";
CREATE POLICY app_provider_email ON "EmailOutbox" FOR INSERT TO tempocove_app WITH CHECK (tempocove_context_valid('provider') AND current_setting('tempocove.action',true)='provider_commit' AND "bookingId"=split_part(current_setting('tempocove.subject',true),'|',1) AND EXISTS(SELECT 1 FROM "Booking" b JOIN "User" h ON h.id=b."hostId" WHERE b.id="bookingId" AND b."workspaceId"="EmailOutbox"."workspaceId" AND (lower("recipientEmail") IN (lower(b."inviteeEmail"),lower(h.email)) OR lower("recipientEmail")=tempocove_workspace_notification_email(b."workspaceId")) AND ("bookingMutationVersion" IS NULL OR "bookingMutationVersion"=b."mutationVersion")) AND status='PENDING' AND "attemptCount"=0 AND "leaseToken" IS NULL);
