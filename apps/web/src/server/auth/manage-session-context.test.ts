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
import { GET as getBooking } from "@/app/api/bookings/[id]/route";

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
