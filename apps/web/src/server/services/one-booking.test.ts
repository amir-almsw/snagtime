import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";
import { ACTIVE_BOOKING_EXISTS, activeBookingIdForEmail, cancelBooking, createBooking, listPublicSlots } from "@/server/services/bookings";

const names = ["EMAIL_TOKEN_SECRET", "NEXT_PUBLIC_APP_URL", "EMAIL_REPLY_TO", "BOOKING_CAPABILITY_KEY_ID", "BOOKING_CAPABILITY_SECRET", "CALENDAR_PROVIDER"] as const;
const created: string[] = [];

// Slots are offered every 15 minutes but run the full service length, so consecutive entries
// overlap; a second booking needs a start at or after the first one's end.
async function twoFreeSlots() {
  const from = new Date(Date.now() + 86_400_000); const to = new Date(Date.now() + 21 * 86_400_000);
  const slots = await listPublicSlots("strategy-call", from, to, "Europe/Amsterdam");
  const first = slots[0]; if (!first) throw new Error("No open slot was available.");
  const second = slots.find((item) => new Date(item.start).getTime() >= new Date(first.end).getTime());
  if (!second) throw new Error("No non-overlapping second slot was available.");
  return { first, second };
}
async function book(email: string, start: string, options?: Parameters<typeof createBooking>[5]) {
  const result = await createBooking("strategy-call", { startAt: start, inviteeName: "One Booking", inviteeEmail: email, inviteeTimeZone: "Europe/Amsterdam" }, `one-booking-${randomUUID()}`, undefined, undefined, options);
  created.push(result.booking.id);
  return result;
}

describe("one live appointment per client", () => {
  beforeEach(() => { process.env.EMAIL_TOKEN_SECRET = "one-booking-secret-that-is-more-than-32-bytes-ok"; process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000"; process.env.EMAIL_REPLY_TO = "support@example.invalid"; process.env.BOOKING_CAPABILITY_KEY_ID = "one-booking-v1"; process.env.BOOKING_CAPABILITY_SECRET = "one-booking-capability-secret-long-enough-42"; process.env.CALENDAR_PROVIDER = "local"; });
  afterEach(async () => { await db.booking.deleteMany({ where: { id: { in: created.splice(0) } } }); for (const name of names) delete process.env[name]; });

  it("refuses a second booking while the first has not concluded and names the booking to reschedule", async () => {
    const { first, second } = await twoFreeSlots();
    const email = `one-booking-${randomUUID()}@example.invalid`;
    const initial = await book(email, first.start);
    const failure = await book(email, second.start).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe(ACTIVE_BOOKING_EXISTS);
    expect((failure as AppError).status).toBe(409);
    expect((failure as AppError & { bookingId?: string }).bookingId).toBe(initial.booking.id);
    expect(await db.booking.count({ where: { inviteeEmail: email } })).toBe(1);
  });

  it("matches the email case-insensitively and leaves other clients unaffected", async () => {
    const { first, second } = await twoFreeSlots();
    // The route lowercases through zod before storing; a client retyping it in caps must still match.
    const email = `mixed-case-${randomUUID()}@example.invalid`;
    await book(email, first.start);
    await expect(book(email.toUpperCase(), second.start)).rejects.toMatchObject({ code: ACTIVE_BOOKING_EXISTS });
    const other = await book(`other-${randomUUID()}@example.invalid`, second.start);
    expect(other.booking.status).toBe("CONFIRMED");
  });

  it("frees the client again once the appointment is cancelled", async () => {
    const { first, second } = await twoFreeSlots();
    const email = `cancel-then-rebook-${randomUUID()}@example.invalid`;
    const initial = await book(email, first.start);
    await cancelBooking(initial.booking.id, "Something came up");
    const again = await book(email, second.start);
    expect(again.booking.status).toBe("CONFIRMED");
  });

  // The studio booking on a client's behalf from its own dashboard is the authority over its own
  // chairs: it books a regular's next appointment while the current one is still ahead of them.
  it("lets the studio book a second appointment for a client who already has one", async () => {
    const { first, second } = await twoFreeSlots();
    const email = `studio-added-${randomUUID()}@example.invalid`;
    await book(email, first.start);
    const added = await book(email, second.start, { allowSecondActiveBooking: true });
    expect(added.booking.status).toBe("CONFIRMED");
    expect(await db.booking.count({ where: { inviteeEmail: email } })).toBe(2);
  });

  it("still refuses a time that is not open, even when the studio adds the booking", async () => {
    const { first } = await twoFreeSlots();
    const email = `studio-clash-${randomUUID()}@example.invalid`;
    await book(email, first.start);
    // The first booking now occupies that slot, so the same start is no longer on the open list.
    await expect(book(`clash-${randomUUID()}@example.invalid`, first.start, { allowSecondActiveBooking: true })).rejects.toMatchObject({ status: 409 });
  });

  it("ignores appointments that have already concluded", async () => {
    const event = await db.eventType.findFirstOrThrow({ where: { slug: "strategy-call" } });
    const email = `past-${randomUUID()}@example.invalid`;
    const past = await db.booking.create({ data: {
      workspaceId: event.workspaceId, eventTypeId: event.id, hostId: event.ownerId, durationMinutes: 30,
      inviteeName: "Past Guest", inviteeEmail: email, inviteeTimeZone: "Europe/Amsterdam",
      startAt: new Date(Date.now() - 3 * 60 * 60_000), endAt: new Date(Date.now() - 2 * 60 * 60_000),
      status: "CONFIRMED", eventTitleSnapshot: event.name, capabilityVersion: randomUUID(), manageExpiresAt: new Date(Date.now() + 86_400_000),
    } });
    created.push(past.id);
    expect(await activeBookingIdForEmail(event.workspaceId, email)).toBeNull();
  });
});
