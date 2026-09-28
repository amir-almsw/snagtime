-- The dashboard's Customers tab: the studio's known clients and its email blacklist. The baseline already
-- carries all of this; this migration is for databases deployed before it, and is safe to re-run.
--
-- Apply as the owner before the new images start: the app refuses nothing without these tables, but every
-- Customers request and every booking's blacklist check would fail until they exist.
CREATE TABLE IF NOT EXISTS "KnownClient" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KnownClient_pkey" PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "BlockedEmail" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BlockedEmail_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "KnownClient_workspaceId_email_key" ON "KnownClient"("workspaceId", "email");
CREATE UNIQUE INDEX IF NOT EXISTS "BlockedEmail_workspaceId_email_key" ON "BlockedEmail"("workspaceId", "email");
DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='KnownClient_workspaceId_fkey') THEN
    ALTER TABLE "KnownClient" ADD CONSTRAINT "KnownClient_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='BlockedEmail_workspaceId_fkey') THEN
    ALTER TABLE "BlockedEmail" ADD CONSTRAINT "BlockedEmail_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $fk$;

-- The baseline's blanket table grant ran before these tables existed, so the application role needs its own.
-- The worker and monitor roles get nothing: neither list is theirs to read.
GRANT SELECT,INSERT,UPDATE,DELETE ON "KnownClient","BlockedEmail" TO tempocove_app;
REVOKE ALL ON "KnownClient","BlockedEmail" FROM PUBLIC,tempocove_worker,tempocove_monitor;
GRANT SELECT ON "BlockedEmail" TO tempocove_rls_verifier;

ALTER TABLE "KnownClient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KnownClient" FORCE ROW LEVEL SECURITY;
ALTER TABLE "BlockedEmail" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BlockedEmail" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_workspace_read ON "KnownClient";
CREATE POLICY app_workspace_read ON "KnownClient" FOR SELECT TO tempocove_app USING (tempocove_workspace_access("workspaceId"));
DROP POLICY IF EXISTS app_workspace_read ON "BlockedEmail";
CREATE POLICY app_workspace_read ON "BlockedEmail" FOR SELECT TO tempocove_app USING (tempocove_workspace_access("workspaceId"));
DROP POLICY IF EXISTS app_known_client_write ON "KnownClient";
CREATE POLICY app_known_client_write ON "KnownClient" FOR ALL TO tempocove_app USING (tempocove_workspace_admin("workspaceId") AND current_setting('tempocove.action',true)='client_write') WITH CHECK (tempocove_workspace_admin("workspaceId") AND current_setting('tempocove.action',true)='client_write');
DROP POLICY IF EXISTS app_blocked_email_write ON "BlockedEmail";
CREATE POLICY app_blocked_email_write ON "BlockedEmail" FOR ALL TO tempocove_app USING (tempocove_workspace_admin("workspaceId") AND current_setting('tempocove.action',true)='blocklist_write') WITH CHECK (tempocove_workspace_admin("workspaceId") AND current_setting('tempocove.action',true)='blocklist_write');

-- createBooking's blacklist check. No public policy exposes a BlockedEmail row, so the public booking
-- context gets one yes or no for its own signed workspace and nothing more.
CREATE OR REPLACE FUNCTION tempocove_email_blocked(p_email text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
  SELECT EXISTS(SELECT 1 FROM "BlockedEmail" x
  WHERE tempocove_context_valid('public') AND current_setting('tempocove.action',true)='booking_create'
    AND x."workspaceId"=current_setting('tempocove.workspace_id',true) AND x.email=lower(p_email))
$fn$;
ALTER FUNCTION tempocove_email_blocked(text) OWNER TO tempocove_rls_verifier;
REVOKE ALL ON FUNCTION tempocove_email_blocked(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tempocove_email_blocked(text) TO tempocove_app;
