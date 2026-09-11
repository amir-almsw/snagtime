-- Database-first availability: the public booking page reads the barber's booked time straight from
-- the database instead of relying on Google FreeBusy, which was the only thing hiding booked slots in
-- production because the public RLS policy exposes no other client's Booking row. The baseline now
-- carries this function; this migration is for databases already deployed without it. It is
-- idempotent (CREATE OR REPLACE), so applying it twice is harmless.
-- Public availability is computed from the database, so a confirmed appointment leaves the booking
-- page immediately instead of waiting for a calendar mirror. No public policy exposes another client's
-- Booking row, so the slot list asks this definer function for the host's booked time: it returns only
-- buffered (start, end) ranges for the published event's host and never a readable row, keeping client
-- names and emails off the public surface. Buffers are validated to at most 240 minutes, so the outer
-- bounds let the (hostId, startAt, endAt) index prune before the exact buffered overlap is applied.
CREATE OR REPLACE FUNCTION tempocove_public_host_busy(p_event text,p_from timestamp,p_to timestamp,p_exclude_booking text DEFAULT NULL)
RETURNS TABLE(busy_start timestamp,busy_end timestamp) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
  SELECT b."startAt"-b."bufferBeforeMinutes"*interval '1 minute',b."endAt"+b."bufferAfterMinutes"*interval '1 minute'
  FROM "Booking" b JOIN "EventType" e ON e."workspaceId"=b."workspaceId" AND e."ownerId"=b."hostId"
  WHERE tempocove_context_valid('public') AND current_setting('tempocove.action',true) IN ('public_read','booking_create')
    AND e.id=p_event AND e."workspaceId"=current_setting('tempocove.workspace_id',true)
    AND split_part(current_setting('tempocove.subject',true),'|',1) IN (e.id,e.slug)
    AND b.status IN ('CONFIRMED','PENDING_PAYMENT')
    AND b."startAt"<p_to+interval '240 minutes' AND b."endAt">p_from-interval '240 minutes'
    AND b."startAt"-b."bufferBeforeMinutes"*interval '1 minute'<p_to AND b."endAt"+b."bufferAfterMinutes"*interval '1 minute'>p_from
    AND (p_exclude_booking IS NULL OR p_exclude_booking='' OR b.id<>p_exclude_booking)
  ORDER BY 1
$fn$;
ALTER FUNCTION tempocove_public_host_busy(text,timestamp,timestamp,text) OWNER TO tempocove_rls_verifier;
REVOKE ALL ON FUNCTION tempocove_public_host_busy(text,timestamp,timestamp,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tempocove_public_host_busy(text,timestamp,timestamp,text) TO tempocove_app;
