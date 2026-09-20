-- The worker renders client emails, and those emails carry the studio's name, accent colour and
-- footer text from WorkspaceBranding. The table has FORCE ROW LEVEL SECURITY and the worker had
-- neither a SELECT grant nor a worker_reference policy on it, so every client-facing message failed
-- with permission denied and retried to DEAD. The organizer copy was unaffected: its render branch
-- returns before the branding read, which is why the studio's mail arrived and the client's did not.
--
-- Read-only, and the table holds no personal data -- a workspace name, a logo URL, a hex colour and
-- a footer line. Invisible on SQLite, which has no row level security at all.
GRANT SELECT ON "WorkspaceBranding" TO tempocove_worker;
DROP POLICY IF EXISTS worker_reference ON "WorkspaceBranding";
CREATE POLICY worker_reference ON "WorkspaceBranding" FOR SELECT TO tempocove_worker USING (true);
