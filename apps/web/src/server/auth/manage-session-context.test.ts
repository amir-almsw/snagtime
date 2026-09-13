import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

// SQLite has no row-level security, so the only way to test the tenant context a route sends to PostgreSQL
// is to observe it. In production the Booking policies expose nothing without a signed capability context,
// so a manage-link read that reaches getBookingDetail() with no store answers 404 for a booking that exists.
const seen = vi.hoisted(() => [] as unknown[]);
vi.mock("@/server/rate-limit", () => ({ enforceRateLimit: async () => undefined, clientAddress: () => "test-client" }));
vi.mock("@/server/services/bookings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/bookings")>();
  const { currentDatabaseContext } = await import("@/server/db-context");
  return { ...actual, getBookingDetail: async (id: string) => { seen.push(currentDatabaseContext()); return actual.getBookingDetail(id); } };
});
import { db } from "@/server/db";
import { manageCookieName } from "@/server/auth/capabilities";
import { SESSION_COOKIE, createSessionForUser } from "@/server/auth/session";
import { GET as getBooking } from "@/app/api/bookings/[id]/route";
import { PATCH as acknowledgeManageSession } from "@/app/api/bookings/[id]/manage-session/route";

describe("booking manage route database context", () => {
  afterEach(() => { vi.unstubAllEnvs(); seen.length = 0; });

  it("reads the booking under the capability context that production RLS requires", async () => {
    // enterDatabaseContext() installs a store only under the production PostgreSQL contract. The db proxy was
    // bound to the SQLite client when the module loaded, so stubbing these two variables lets the test watch
    // the context the handler would hand to PostgreSQL without touching the database wiring.
    vi.stubEnv("DATABASE_PROVIDER", "postgresql"); vi.stubEnv("NODE_ENV", "production");
    const event = await db.eventType.findFirstOrThrow({ include: { durations: true } }); const duration = event.durations[0]!; const bookingId = randomUUID(); const sessionToken = randomUUID();
    await db.booking.create({ data: {
      id: bookingId, workspaceId: event.workspaceId, eventTypeId: event.id, hostId: event.ownerId, durationId: duration.id, durationMinutes: duration.durationMinutes,
      inviteeName: "Context Probe", inviteeEmail: "context-probe@example.com", inviteeTimeZone: "Europe/Amsterdam", startAt: new Date("2099-08-25T09:00:00Z"), endAt: new Date("2099-08-25T09:30:00Z"), status: "CONFIRMED",
      idempotencyKey: randomUUID(), requestFingerprint: randomUUID(), capabilityVersion: randomUUID(), manageExpiresAt: new Date("2099-09-25T00:00:00Z"),
      manageSessions: { create: { tokenHash: createHash("sha256").update(sessionToken).digest("hex"), scopes: "read,cancel,reschedule", expiresAt: new Date("2099-09-25T00:00:00Z"), acknowledgedAt: new Date() } },
    } });
    try {
      const response = await getBooking(new Request(`http://localhost:3000/api/bookings/${bookingId}`, { headers: { cookie: `${manageCookieName(bookingId)}=${sessionToken}` } }), { params: Promise.resolve({ id: bookingId }) });
      expect(response.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ mode: "capability", subject: bookingId });
    } finally { await db.booking.delete({ where: { id: bookingId } }); }
  });
});

// The dashboard's Reschedule link and the client's emailed link render the same view, and that view
// acknowledges the manage session on load. An organizer holds no manage cookie for the booking, so the
// acknowledge answered 404 and the studio saw "Booking was not found" on every reschedule; cancel worked
// only because that view never acknowledges.
describe("organizer acknowledge on the shared manage view", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("treats a valid organizer session as nothing to acknowledge, and still fails closed without one", async () => {
    vi.stubEnv("AUTH_SECRET", "manage-ack-test-secret-of-at-least-thirty-two-bytes");
    const event = await db.eventType.findFirstOrThrow({ include: { durations: true } }); const duration = event.durations[0]!; const bookingId = randomUUID();
    await db.booking.create({ data: {
      id: bookingId, workspaceId: event.workspaceId, eventTypeId: event.id, hostId: event.ownerId, durationId: duration.id, durationMinutes: duration.durationMinutes,
      inviteeName: "Organizer Ack", inviteeEmail: "organizer-ack@example.com", inviteeTimeZone: "Europe/Amsterdam", startAt: new Date("2099-08-26T09:00:00Z"), endAt: new Date("2099-08-26T09:30:00Z"), status: "CONFIRMED",
      idempotencyKey: randomUUID(), requestFingerprint: randomUUID(), capabilityVersion: randomUUID(), manageExpiresAt: new Date("2099-09-26T00:00:00Z"),
    } });
    const url = `http://localhost:3000/api/bookings/${bookingId}/manage-session`;
    const params = { params: Promise.resolve({ id: bookingId }) };
    // Everything after the create lives inside the try: these suites share one SQLite database, so a
    // throw between creating the fixture and the cleanup leaks a booking into every later test file.
    try {
      const token = await createSessionForUser(event.ownerId, undefined, false);
      const organizer = await acknowledgeManageSession(new Request(url, { method: "PATCH", headers: { origin: "http://localhost:3000", cookie: `${SESSION_COOKIE}=${token}` } }), params);
      expect(organizer.status).toBe(200);
      await expect(organizer.json()).resolves.toMatchObject({ data: { acknowledged: true } });
      // Neither an organizer session nor a manage cookie must still be refused, or the short circuit
      // would have turned the acknowledge into an unauthenticated no-op for anyone who asked.
      const anonymous = await acknowledgeManageSession(new Request(url, { method: "PATCH", headers: { origin: "http://localhost:3000" } }), params);
      expect(anonymous.status).toBe(404);
    } finally { await db.authSession.deleteMany({ where: { userId: event.ownerId } }); await db.booking.delete({ where: { id: bookingId } }); }
  });
});
