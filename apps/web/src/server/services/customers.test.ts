import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db";
import { currentDatabaseContext, enterDatabaseContext, type DatabaseContext } from "@/server/db-context";
import { SESSION_COOKIE, createSessionForUser } from "@/server/auth/session";
import { addKnownClient, blockEmail, deleteKnownClient, importKnownClients, listBlockedEmails, listKnownClients, unblockEmail } from "@/server/services/customers";
import { createBooking } from "@/server/services/bookings";
import { GET as listCustomers, POST as addCustomer } from "@/app/api/customers/route";
import { POST as importCustomers } from "@/app/api/customers/import/route";

const workspaceIds: string[] = []; const userIds: string[] = []; const blockedIds: string[] = [];
async function studio(label: string, role = "OWNER") {
  const user = await db.user.create({ data: { email: `${label}-${randomUUID()}@example.com`, name: label, passwordHash: "test", emailVerifiedAt: new Date(), timeZone: "Europe/Amsterdam" } });
  const workspace = await db.workspace.create({ data: { name: `${label} studio`, timeZone: "Europe/Amsterdam" } });
  const membership = await db.membership.create({ data: { workspaceId: workspace.id, userId: user.id, role } });
  const event = await db.eventType.create({ data: { workspaceId: workspace.id, ownerId: user.id, name: `${label} cut`, slug: `${label}-${randomUUID()}`, locationType: "CUSTOM" } });
  workspaceIds.push(workspace.id); userIds.push(user.id);
  return { user, workspace, membership, event };
}
async function appointment(owner: Awaited<ReturnType<typeof studio>>, email: string, startAt: Date, status = "CONFIRMED") {
  return db.booking.create({ data: {
    workspaceId: owner.workspace.id, eventTypeId: owner.event.id, hostId: owner.user.id, durationMinutes: 45,
    inviteeName: "Blocked Client", inviteeEmail: email, inviteeTimeZone: "Europe/Amsterdam", startAt, endAt: new Date(startAt.getTime() + 45 * 60_000),
    status, eventTitleSnapshot: owner.event.name, capabilityVersion: randomUUID(), manageExpiresAt: new Date(startAt.getTime() + 30 * 24 * 60 * 60_000),
  } });
}
function organizerRequest(path: string, token: string, body?: unknown) {
  return new Request(`http://localhost:3000${path}`, body === undefined ? { headers: { cookie: `${SESSION_COOKIE}=${token}` } } : { method: "POST", headers: { origin: "http://localhost:3000", cookie: `${SESSION_COOKIE}=${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("the Customers tab", () => {
  beforeEach(() => { vi.stubEnv("AUTH_SECRET", "customers-test-session-secret-that-is-long-enough"); process.env.EMAIL_TOKEN_SECRET = "customers-test-secret-that-is-more-than-thirty-two-bytes"; process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000"; process.env.EMAIL_REPLY_TO = "support@example.invalid"; process.env.BOOKING_CAPABILITY_KEY_ID = "customers-test-v1"; process.env.BOOKING_CAPABILITY_SECRET = "customers-capability-secret-that-is-long-enough-9"; process.env.CALENDAR_PROVIDER = "local"; });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    if (blockedIds.length) await db.blockedEmail.deleteMany({ where: { id: { in: blockedIds.splice(0) } } });
    const owned = workspaceIds.splice(0);
    await db.authSession.deleteMany({ where: { userId: { in: userIds } } });
    await db.booking.deleteMany({ where: { workspaceId: { in: owned } } });
    await db.workspace.deleteMany({ where: { id: { in: owned } } });
    await db.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
  });

  it("adds a customer through the route, lower-casing the address, and refuses the same address twice", async () => {
    const owner = await studio("customers-add"); const token = await createSessionForUser(owner.user.id, owner.membership.id, false);
    const created = await addCustomer(organizerRequest("/api/customers", token, { name: "  Amir El Idrissi ", email: " Amir@Example.NL ", phone: "0612345678" }));
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({ data: { name: "Amir El Idrissi", email: "amir@example.nl", phone: "0612345678", blocked: false } });
    const again = await addCustomer(organizerRequest("/api/customers", token, { name: "Someone Else", email: "amir@example.nl" }));
    expect(again.status).toBe(409);
    const listed = await listCustomers(organizerRequest("/api/customers", token));
    await expect(listed.json()).resolves.toMatchObject({ data: [{ email: "amir@example.nl" }] });
  });

  it("keeps a member out of the writes and every caller without a session out of the list", async () => {
    const member = await studio("customers-member", "MEMBER"); const token = await createSessionForUser(member.user.id, member.membership.id, false);
    expect((await addCustomer(organizerRequest("/api/customers", token, { name: "Nope", email: "nope@example.nl" }))).status).toBe(403);
    expect((await listCustomers(new Request("http://localhost:3000/api/customers"))).status).toBe(401);
  });

  it("imports create-only: an address already listed keeps its name, repeats and bad rows are counted, not stored", async () => {
    const owner = await studio("customers-import"); const token = await createSessionForUser(owner.user.id, owner.membership.id, false);
    await addKnownClient(owner.workspace.id, { name: "Corrected By Hand", email: "kept@example.nl" });
    const response = await importCustomers(organizerRequest("/api/customers/import", token, { clients: [
      { name: "Old Export Name", email: "KEPT@example.nl" },
      { name: "New Client", email: "new@example.nl", phone: "0611111111" },
      { name: "New Client Again", email: "new@example.nl" },
      { name: "", email: "nameless@example.nl" },
      { name: "Bad Address", email: "not-an-email" },
    ] }));
    await expect(response.json()).resolves.toEqual({ data: { added: 1, skipped: 2, invalid: 2 } });
    expect((await listKnownClients(owner.workspace.id)).map(({ name, email, phone }) => ({ name, email, phone }))).toEqual([
      { name: "Corrected By Hand", email: "kept@example.nl", phone: null },
      { name: "New Client", email: "new@example.nl", phone: "0611111111" },
    ]);
  });

  it("removes a customer only inside the studio that owns it", async () => {
    const owner = await studio("customers-owner"); const other = await studio("customers-other");
    const client = await addKnownClient(owner.workspace.id, { name: "Only Mine", email: "mine@example.nl" });
    await expect(deleteKnownClient(other.workspace.id, client.id)).rejects.toMatchObject({ status: 404 });
    await expect(deleteKnownClient(owner.workspace.id, client.id)).resolves.toEqual({ deleted: true });
    expect(await listKnownClients(owner.workspace.id)).toEqual([]);
  });

  it("blacklists an address and cancels only that address's upcoming appointments, once", async () => {
    const owner = await studio("customers-block"); const email = `blocked-${randomUUID()}@example.nl`;
    await addKnownClient(owner.workspace.id, { name: "Blocked Client", email });
    const upcoming = await appointment(owner, email, new Date(Date.now() + 3 * 24 * 60 * 60_000));
    const past = await appointment(owner, email, new Date(Date.now() - 3 * 24 * 60 * 60_000));
    const someoneElse = await appointment(owner, `other-${randomUUID()}@example.nl`, new Date(Date.now() + 4 * 24 * 60 * 60_000));
    const result = await blockEmail(owner.workspace.id, { email, reason: "No-shows" });
    expect(result).toMatchObject({ canceled: 1, failed: 0, entry: { email, reason: "No-shows", clientName: "Blocked Client" } });
    expect(await db.booking.findUniqueOrThrow({ where: { id: upcoming.id } })).toMatchObject({ status: "CANCELLED", cancellationReason: "Canceled by the studio" });
    expect(await db.booking.findUniqueOrThrow({ where: { id: past.id } })).toMatchObject({ status: "CONFIRMED" });
    expect(await db.booking.findUniqueOrThrow({ where: { id: someoneElse.id } })).toMatchObject({ status: "CONFIRMED" });
    // The client is told, through the ordinary cancellation email.
    expect(await db.emailOutbox.count({ where: { bookingId: upcoming.id, kind: "BOOKING_CANCELLED", recipientEmail: email } })).toBe(1);
    // Blacklisting again is a no-op rather than a second row or a second cancellation.
    await expect(blockEmail(owner.workspace.id, { email })).resolves.toMatchObject({ canceled: 0, entry: { id: result.entry.id, reason: "No-shows" } });
    expect(await listBlockedEmails(owner.workspace.id)).toHaveLength(1);
    expect((await listKnownClients(owner.workspace.id))[0]).toMatchObject({ email, blocked: true });
    await expect(unblockEmail(owner.workspace.id, result.entry.id)).resolves.toEqual({ deleted: true });
    expect((await listKnownClients(owner.workspace.id))[0]).toMatchObject({ blocked: false });
  });

  it("refuses a blacklisted address on the booking page and in the dashboard, each with its own wording", async () => {
    const event = await db.eventType.findUniqueOrThrow({ where: { slug: "strategy-call" }, include: { durations: true } });
    const email = `refused-${randomUUID()}@example.nl`;
    blockedIds.push((await db.blockedEmail.create({ data: { workspaceId: event.workspaceId, email } })).id);
    const input = { startAt: "2099-08-25T07:00:00.000Z", inviteeName: "Refused Client", inviteeEmail: email, inviteeTimeZone: "Europe/Amsterdam", durationId: event.durations[0]!.id };
    await expect(createBooking(event.slug, input, `refused-public-${randomUUID()}`)).rejects.toMatchObject({ code: "EMAIL_BLOCKED", status: 403, message: expect.stringMatching(/contact the studio/) });
    await expect(createBooking(event.slug, input, `refused-studio-${randomUUID()}`, undefined, undefined, { allowSecondActiveBooking: true, byStudio: true })).rejects.toMatchObject({ code: "EMAIL_BLOCKED", message: expect.stringMatching(/blacklist/) });
    expect(await db.booking.count({ where: { inviteeEmail: email } })).toBe(0);
  });

  // SQLite has no row-level security, so the only way to test what production PostgreSQL will be asked is
  // to watch it. enterDatabaseContext installs a store only under the production contract; the db client
  // was bound to SQLite when the module loaded, so stubbing the two variables changes nothing else.
  it("writes each list under the action its production policy requires", async () => {
    vi.stubEnv("DATABASE_PROVIDER", "postgresql"); vi.stubEnv("NODE_ENV", "production");
    const owner = await studio("customers-context"); const seen: Array<{ call: string; context: Partial<DatabaseContext> }> = [];
    const watch = <T extends object>(delegate: T, method: keyof T & string, label: string) => {
      const original = (delegate[method] as (...args: unknown[]) => unknown).bind(delegate);
      vi.spyOn(delegate, method as never).mockImplementation(((...args: unknown[]) => { seen.push({ call: label, context: { ...currentDatabaseContext() } }); return original(...args); }) as never);
    };
    watch(db.knownClient, "create", "client.create"); watch(db.knownClient, "createMany", "client.createMany"); watch(db.knownClient, "deleteMany", "client.delete");
    watch(db.blockedEmail, "upsert", "blocked.upsert"); watch(db.blockedEmail, "deleteMany", "blocked.delete");
    enterDatabaseContext({ mode: "workspace", workspaceId: owner.workspace.id, userId: owner.user.id, subject: "OWNER", action: "workspace_read" });
    const client = await addKnownClient(owner.workspace.id, { name: "Context Client", email: "context@example.nl" });
    await importKnownClients(owner.workspace.id, [{ name: "Imported", email: "imported@example.nl" }]);
    await deleteKnownClient(owner.workspace.id, client.id);
    const blocked = await blockEmail(owner.workspace.id, { email: "context-blocked@example.nl" });
    await unblockEmail(owner.workspace.id, blocked.entry.id);
    expect(seen.map(({ call, context }) => [call, context.mode, context.workspaceId, context.action])).toEqual([
      ["client.create", "workspace", owner.workspace.id, "client_write"],
      ["client.createMany", "workspace", owner.workspace.id, "client_write"],
      ["client.delete", "workspace", owner.workspace.id, "client_write"],
      ["blocked.upsert", "workspace", owner.workspace.id, "blocklist_write"],
      ["blocked.delete", "workspace", owner.workspace.id, "blocklist_write"],
    ]);
  });

  it("asks the definer, under the public booking context, whether an address is blacklisted in production", async () => {
    vi.stubEnv("DATABASE_PROVIDER", "postgresql"); vi.stubEnv("NODE_ENV", "production");
    const event = await db.eventType.findUniqueOrThrow({ where: { slug: "strategy-call" }, include: { durations: true } });
    const asked: Array<{ sql: string; context: Partial<DatabaseContext> }> = [];
    vi.spyOn(db, "$queryRawUnsafe").mockImplementation((async (sql: string) => { asked.push({ sql, context: { ...currentDatabaseContext() } }); return [{ blocked: true }]; }) as never);
    const input = { startAt: "2099-08-25T07:00:00.000Z", inviteeName: "Definer Client", inviteeEmail: `definer-${randomUUID()}@example.nl`, inviteeTimeZone: "Europe/Amsterdam", durationId: event.durations[0]!.id };
    await expect(createBooking(event.slug, input, `definer-${randomUUID()}`)).rejects.toMatchObject({ code: "EMAIL_BLOCKED" });
    expect(asked).toEqual([{ sql: "SELECT tempocove_email_blocked($1::text) AS blocked", context: expect.objectContaining({ mode: "public", workspaceId: event.workspaceId, action: "booking_create" }) }]);
  });
});
