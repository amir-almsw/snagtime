-- The Customers tab's bulk "Message selected" action. The regenerated baseline already carries this policy
-- for fresh databases; this file is for databases deployed before it and is safe to re-run.
--
-- Apply as the owner before the new web-admin image starts: without it, every bulk message insert is
-- refused by row-level security under production PostgreSQL (the other EmailOutbox insert policies all
-- require a booking, or a specific non-bulk kind).
DROP POLICY IF EXISTS app_bulk_email_insert ON "EmailOutbox";
CREATE POLICY app_bulk_email_insert ON "EmailOutbox" FOR INSERT TO tempocove_app WITH CHECK (
  tempocove_workspace_admin("workspaceId")
  AND current_setting('tempocove.action',true)='bulk_email_write'
  AND "bookingId" IS NULL AND kind='BULK_MESSAGE'
  AND status='PENDING' AND "attemptCount"=0 AND "leaseToken" IS NULL
);