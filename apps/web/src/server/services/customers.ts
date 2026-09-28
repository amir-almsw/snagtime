import type { BlockedEmailEntry, BlockEmailResult, KnownClient, KnownClientImportResult } from "@/lib/contracts";
import { db } from "@/server/db";
import { enterDatabaseAction } from "@/server/db-context";
import { conflict, notFound } from "@/server/errors";
import { structuredLog } from "@/server/observability";
import { cancelBooking } from "@/server/services/bookings";
import { failureCode } from "@/server/services/notifications";
import { knownClientInput } from "@/server/validation";

// The dashboard's Customers tab: the studio's address book of known clients, and its email blacklist.
// Every write re-tags the organizer context with its own action (client_write, blocklist_write), which is
// what the KnownClient and BlockedEmail write policies in postgres-guards.sql require; reads ride the
// ordinary workspace read. SQLite enforces none of it, so the actions are pinned by customers.test.ts.

type ClientRow = { id: string; name: string; email: string; phone: string | null; createdAt: Date };
const clientSelect = { id: true, name: true, email: true, phone: true, createdAt: true } as const;
const byName = (left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name, "nl", { sensitivity: "base" });
function mapClient(row: ClientRow, blocked: Set<string>): KnownClient {
  return { id: row.id, name: row.name, email: row.email, phone: row.phone, createdAt: row.createdAt.toISOString(), blocked: blocked.has(row.email) };
}
async function blockedEmails(workspaceId: string) {
  return new Set((await db.blockedEmail.findMany({ where: { workspaceId }, select: { email: true } })).map((row) => row.email));
}
function isUniqueViolation(error: unknown) { return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "P2002"); }

export async function listKnownClients(workspaceId: string): Promise<KnownClient[]> {
  const rows = await db.knownClient.findMany({ where: { workspaceId }, select: clientSelect });
  const blocked = await blockedEmails(workspaceId);
  return rows.sort(byName).map((row) => mapClient(row, blocked));
}

export async function addKnownClient(workspaceId: string, input: { name: string; email: string; phone?: string }): Promise<KnownClient> {
  enterDatabaseAction("client_write");
  let row: ClientRow;
  try { row = await db.knownClient.create({ data: { workspaceId, name: input.name, email: input.email, phone: input.phone || null }, select: clientSelect }); }
  catch (error) { if (isUniqueViolation(error)) throw conflict("That email is already on the customer list."); throw error; }
  return mapClient(row, await blockedEmails(workspaceId));
}

// Create-only, like the seed: an address already on the list keeps whatever the barber has there, so
// importing the same export twice, or an older one, can never overwrite a correction made by hand.
// Rows are validated one at a time; a bad line is counted and skipped rather than failing the file.
export async function importKnownClients(workspaceId: string, rows: unknown[]): Promise<KnownClientImportResult> {
  const incoming = new Map<string, { name: string; email: string; phone?: string }>(); let invalid = 0; let repeated = 0;
  for (const row of rows) {
    const parsed = knownClientInput.safeParse(row);
    if (!parsed.success) { invalid += 1; continue; }
    if (incoming.has(parsed.data.email)) { repeated += 1; continue; }
    incoming.set(parsed.data.email, parsed.data);
  }
  enterDatabaseAction("client_write");
  const existing = new Set((await db.knownClient.findMany({ where: { workspaceId }, select: { email: true } })).map((row) => row.email));
  const fresh = [...incoming.values()].filter((client) => !existing.has(client.email));
  if (fresh.length) {
    try { await db.knownClient.createMany({ data: fresh.map((client) => ({ workspaceId, name: client.name, email: client.email, phone: client.phone || null })) }); }
    catch (error) { if (isUniqueViolation(error)) throw conflict("The customer list changed during the import. Import the file again; nothing is added twice."); throw error; }
  }
  return { added: fresh.length, skipped: incoming.size - fresh.length + repeated, invalid };
}

export async function deleteKnownClient(workspaceId: string, id: string) {
  enterDatabaseAction("client_write");
  const removed = await db.knownClient.deleteMany({ where: { id, workspaceId } });
  if (removed.count !== 1) throw notFound("Customer");
  return { deleted: true as const };
}

async function mapBlocked(workspaceId: string, rows: Array<{ id: string; email: string; reason: string | null; createdAt: Date }>): Promise<BlockedEmailEntry[]> {
  const names = new Map((await db.knownClient.findMany({ where: { workspaceId, email: { in: rows.map((row) => row.email) } }, select: { email: true, name: true } })).map((row) => [row.email, row.name]));
  return rows.map((row) => ({ id: row.id, email: row.email, reason: row.reason, createdAt: row.createdAt.toISOString(), clientName: names.get(row.email) ?? null }));
}

export async function listBlockedEmails(workspaceId: string): Promise<BlockedEmailEntry[]> {
  return mapBlocked(workspaceId, await db.blockedEmail.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } }));
}

// The block is written first, so from this moment createBooking refuses the address, and only then are the
// address's upcoming appointments cancelled -- each through the ordinary cancelBooking, so the calendar
// event, the client's cancellation email and any pending reminder are handled exactly as for a manual
// cancel. One appointment that will not cancel (a calendar write in flight, say) does not undo the block
// or stop the others; it is counted so the dashboard can say which step to finish by hand.
export async function blockEmail(workspaceId: string, input: { email: string; reason?: string }, now = new Date()): Promise<BlockEmailResult> {
  enterDatabaseAction("blocklist_write");
  const entry = await db.blockedEmail.upsert({
    where: { workspaceId_email: { workspaceId, email: input.email } },
    update: input.reason ? { reason: input.reason } : {},
    create: { workspaceId, email: input.email, reason: input.reason || null },
  });
  const upcoming = await db.booking.findMany({ where: { workspaceId, inviteeEmail: input.email, status: { in: ["CONFIRMED", "PENDING_PAYMENT"] }, endAt: { gt: now } }, select: { id: true }, orderBy: { startAt: "asc" } });
  let canceled = 0; let failed = 0;
  for (const booking of upcoming) {
    try { await cancelBooking(booking.id, "Canceled by the studio"); canceled += 1; }
    catch (error) { failed += 1; structuredLog("warn", { event: "blocklist.cancel_failed", code: failureCode(error) }); }
  }
  const [mapped] = await mapBlocked(workspaceId, [entry]);
  return { entry: mapped!, canceled, failed };
}

export async function unblockEmail(workspaceId: string, id: string) {
  enterDatabaseAction("blocklist_write");
  const removed = await db.blockedEmail.deleteMany({ where: { id, workspaceId } });
  if (removed.count !== 1) throw notFound("Blacklist entry");
  return { deleted: true as const };
}
