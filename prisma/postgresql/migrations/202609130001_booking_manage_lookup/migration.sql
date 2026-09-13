-- Adds the client-facing booking reference and the lookup behind "manage my appointment" without the
-- emailed link. The baseline already carries both; this migration is for databases deployed before them.
--
-- The column is nullable so it can be added to a populated table: bookings taken before this point were
-- never given a code, and null simply never matches a lookup. Every booking created from here on gets one
-- from createBooking.
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "reference" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Booking_reference_key" ON "Booking"("reference");

-- No policy can express this lookup, because the caller does not yet know the booking id that every
-- capability policy keys on. The definer function returns one id and one address -- never a booking row --
-- and binds to the signed context subject so it cannot be walked through references or addresses.
CREATE OR REPLACE FUNCTION tempocove_booking_manage_lookup(p_reference text,p_email text,p_now timestamp)
RETURNS TABLE(booking_id text,invitee_email text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
  SELECT b."id",lower(b."inviteeEmail") FROM "Booking" b
  WHERE tempocove_context_valid('capability') AND current_setting('tempocove.action',true)='booking_manage_lookup'
    AND b."status"='CONFIRMED' AND b."endAt">p_now
    AND ((p_reference<>'' AND b."reference"=p_reference AND current_setting('tempocove.subject',true)=p_reference)
      OR (p_email<>'' AND lower(b."inviteeEmail")=p_email AND current_setting('tempocove.subject',true)=p_email))
  ORDER BY b."startAt"
  LIMIT 1
$fn$;
ALTER FUNCTION tempocove_booking_manage_lookup(text,text,timestamp) OWNER TO tempocove_rls_verifier;
REVOKE ALL ON FUNCTION tempocove_booking_manage_lookup(text,text,timestamp) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tempocove_booking_manage_lookup(text,text,timestamp) TO tempocove_app;
