import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { generateBookingReference } from "@/server/services/booking-reference";
import { requestBookingManageLinkByLookup } from "@/server/services/booking-recovery";

const names = ["EMAIL_TOKEN_SECRET", "NEXT_PUBLIC_APP_URL", "EMAIL_REPLY_TO"] as const;
const bookingIds: string[] = [];

// Every fixture is deliberately far in the future or far in the past, so "upcoming" is never ambiguous.
async function seedBooking(overrides: { email: string; reference?: string | null; status?: string; startAt: Date; endAt: Date }) {
  const event = await db.eventType.findFirstOrThrow({ include: { durations: true } }); const duration = event.durations[0]!; const id = randomUUID();
  await db.booking.create({ data: {
    id, reference: overrides.reference === undefined ? generateBookingReference() : overrides.reference,
    workspaceId: event.workspaceId, eventTypeId: event.id, hostId: event.ownerId, durationId: duration.id, durationMinutes: duration.durationMinutes,
    inviteeName: "Lookup Probe", inviteeEmail: overrides.email, inviteeTimeZone: "Europe/Amsterdam",
    startAt: overrides.startAt, endAt: overrides.endAt, status: overrides.status ?? "CONFIRMED",
    idempotencyKey: randomUUID(), requestFingerprint: randomUUID(), capabilityVersion: randomUUID(), manageExpiresAt: new Date("2099-12-31T00:00:00Z"),
  } });
  bookingIds.push(id);
  return id;
}
const linksSentFor = async (bookingId: string) => db.emailOutbox.count({ where: { bookingId, kind: "BOOKING_RECOVERY" } });

describe("manage-my-appointment lookup", () => {
  beforeEach(() => {
    process.env.EMAIL_TOKEN_SECRET = "lookup-test-secret-that-is-more-than-thirty-two-b";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    process.env.EMAIL_REPLY_TO = "support@example.invalid";
  });
  afterEach(async () => { await db.booking.deleteMany({ where: { id: { in: bookingIds.splice(0) } } }); for (const name of names) delete process.env[name]; });

  it("sends a link for an upcoming booking found by its reference, however the client typed it", async () => {
    const reference = generateBookingReference();
    const id = await seedBooking({ email: `ref-${randomUUID()}@example.invalid`, reference, startAt: new Date("2099-03-01T09:00:00Z"), endAt: new Date("2099-03-01T09:30:00Z") });
    await expect(requestBookingManageLinkByLookup({ reference: reference.toLowerCase().replace("-", " ") })).resolves.toEqual({ accepted: true });
    expect(await linksSentFor(id)).toBe(1);
  });

  it("sends a link for the soonest upcoming booking found by email", async () => {
    const email = `soonest-${randomUUID()}@example.invalid`;
    const later = await seedBooking({ email, startAt: new Date("2099-06-01T09:00:00Z"), endAt: new Date("2099-06-01T09:30:00Z") });
    const sooner = await seedBooking({ email, startAt: new Date("2099-04-01T09:00:00Z"), endAt: new Date("2099-04-01T09:30:00Z") });
    await requestBookingManageLinkByLookup({ email: email.toUpperCase() });
    expect(await linksSentFor(sooner)).toBe(1);
    expect(await linksSentFor(later)).toBe(0);
  });

  it("finds nothing for a concluded or cancelled appointment, and says so no differently", async () => {
    const pastEmail = `past-${randomUUID()}@example.invalid`; const pastReference = generateBookingReference();
    const past = await seedBooking({ email: pastEmail, reference: pastReference, startAt: new Date("2020-01-01T09:00:00Z"), endAt: new Date("2020-01-01T09:30:00Z") });
    const cancelledEmail = `cancelled-${randomUUID()}@example.invalid`; const cancelledReference = generateBookingReference();
    const cancelled = await seedBooking({ email: cancelledEmail, reference: cancelledReference, status: "CANCELLED", startAt: new Date("2099-05-01T09:00:00Z"), endAt: new Date("2099-05-01T09:30:00Z") });
    for (const input of [{ reference: pastReference }, { email: pastEmail }, { reference: cancelledReference }, { email: cancelledEmail }]) {
      await expect(requestBookingManageLinkByLookup(input)).resolves.toEqual({ accepted: true });
    }
    expect(await linksSentFor(past)).toBe(0);
    expect(await linksSentFor(cancelled)).toBe(0);
  });

  it("accepts input that matches nobody without writing anything", async () => {
    const before = await db.emailOutbox.count();
    for (const input of [{ reference: generateBookingReference() }, { email: `nobody-${randomUUID()}@example.invalid` }, { reference: "not-a-reference" }, { reference: "'; DROP TABLE Booking; --" }]) {
      await expect(requestBookingManageLinkByLookup(input)).resolves.toEqual({ accepted: true });
    }
    expect(await db.emailOutbox.count()).toBe(before);
  });
});
