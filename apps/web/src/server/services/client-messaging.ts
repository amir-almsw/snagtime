import { randomUUID } from "node:crypto";
import type { ClientMessageInput, ClientMessageResult } from "@/lib/contracts";
import { db } from "@/server/db";
import { enterDatabaseAction } from "@/server/db-context";
import { structuredLog } from "@/server/observability";
import { escapeHtml } from "@/server/services/email-template";
import { enqueueEmail, processEmailOutbox } from "@/server/services/notifications";
import { shouldDrainOutboxInline } from "@/server/services/outbox-dispatch";

// The Customers tab's bulk "Message selected" action. One EmailOutbox row per recipient, spaced out so a
// large blast cannot trip the studio's Brevo sending limits; rows are booking-less and render() treats
// kind "BULK_MESSAGE" as already-rendered content. The first recipient goes out immediately and each
// following one ~10s later, which survives a worker restart because the spacing lives in nextAttemptAt.
export const BULK_MESSAGE_SPACING_MS = 10_000;

const SANS = "'Helvetica Neue',Helvetica,Arial,sans-serif";
const INK = "#1F1F1F"; const MUTED = "#6B6B6B"; const PAPER = "#FFFFFF";
const OPT_OUT = "You're receiving this because you've booked with Dvision Studio. If you'd prefer not to receive emails like this, just reply to this message and let me know.";

// Best-effort plain-text fallback for the required EmailDelivery.text part. Not a security boundary --
// the HTML is admin-authored and trusted -- just a readable alternative for plain-text inboxes.
function htmlToText(html: string) {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"").replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// The studio's own shell around the composed fragment: the same deliberately old-fashioned, inline-styled
// mail the client emails use, plus the brand footer and the opt-out line.
function broadcastDocument(bodyHtml: string, footerText: string | null) {
  const footer = footerText ? `<p style="margin:24px 0 0;font:400 12px/1.5 ${SANS};color:${MUTED};">${escapeHtml(footerText)}</p>` : "";
  const optOut = `<p style="margin:12px 0 0;font:400 12px/1.5 ${SANS};color:${MUTED};">${OPT_OUT}</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="color-scheme" content="light" /><meta name="supported-color-schemes" content="light" /></head>
<body style="margin:0;padding:0;background:${PAPER};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};">
    <tr><td style="padding:28px 20px 40px;background:${PAPER};">
      <div style="max-width:640px;font:400 14px/1.5 ${SANS};color:${INK};">
        ${bodyHtml}
        ${footer}
        ${optOut}
      </div>
    </td></tr>
  </table>
</body></html>`;
}

export async function sendClientMessage(workspaceId: string, input: ClientMessageInput, now = new Date()): Promise<ClientMessageResult> {
  const requested = [...new Set(input.clientIds)];
  const clients = await db.knownClient.findMany({ where: { workspaceId, id: { in: requested } }, select: { id: true, email: true } });
  const emailById = new Map(clients.map((client) => [client.id, client.email.toLowerCase()]));
  const blocked = new Set((await db.blockedEmail.findMany({ where: { workspaceId, email: { in: [...emailById.values()] } }, select: { email: true } })).map((row) => row.email));

  const recipients: string[] = []; const seen = new Set<string>(); let notFound = 0; let skippedBlocked = 0;
  for (const id of requested) {
    const email = emailById.get(id);
    if (!email) { notFound += 1; continue; }
    if (blocked.has(email)) { skippedBlocked += 1; continue; }
    if (seen.has(email)) continue;
    seen.add(email); recipients.push(email);
  }
  if (!recipients.length) return { queued: 0, skippedBlocked, notFound };

  const brand = await db.workspace.findUnique({ where: { id: workspaceId }, select: { branding: { select: { footerText: true } } } });
  const footerText = brand?.branding?.footerText ?? null;
  const html = broadcastDocument(input.html, footerText);
  const text = `${htmlToText(input.html)}${footerText ? `\n\n${footerText}` : ""}\n\n${OPT_OUT}`;
  const messageId = randomUUID();

  // The write policy app_bulk_email_insert (postgres-guards.sql) checks this action, mirroring how the
  // known-client and blacklist writes tag their own context. SQLite enforces none of it.
  enterDatabaseAction("bulk_email_write");
  await db.$transaction(async (tx) => {
    for (let index = 0; index < recipients.length; index += 1) {
      const email = recipients[index]!;
      await enqueueEmail(tx, {
        workspaceId,
        kind: "BULK_MESSAGE",
        recipientEmail: email,
        subject: input.subject,
        payload: { audience: "broadcast", messageId, html, text },
        idempotencyKey: `email:bulk:${messageId}:${email}`,
        nextAttemptAt: new Date(now.getTime() + index * BULK_MESSAGE_SPACING_MS),
      });
    }
  });

  // Test runs (and demo with inline drain on) deliver the first row right away; the rest stay scheduled.
  if (shouldDrainOutboxInline()) await processEmailOutbox(workspaceId);
  structuredLog("info", { event: "bulk_message_queued", workspaceId, messageId, recipients: recipients.length });
  return { queued: recipients.length, skippedBlocked, notFound };
}