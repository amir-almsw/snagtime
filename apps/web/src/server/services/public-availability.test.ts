import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db";
import { listPublicSlots } from "@/server/services/bookings";
import type { CalendarService } from "@/server/services/calendar";

// The client-facing slot list must equal the host's open schedule minus the appointments other clients
// already hold, with no dependency on a calendar provider. These tests drive listPublicSlots against the
// seeded studio schedule (Mon–Fri 09:00–17:00 Europe/Amsterdam) with a provider that reports nothing.
const noProviderBusy: CalendarService = { async getBusyIntervals() { return []; }, async createBookingEvent() { return null; }, async updateBookingEvent() {}, async deleteBookingEvent() {} };
const createdBookingIds: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); if (createdBookingIds.length) await db.booking.deleteMany({ where: { id: { in: createdBookingIds.splice(0) } } }); });

// A weekday at least a week out, so it sits past the minimum notice and inside the booking window, and
// a 10:00 UTC anchor that is inside working hours in both Amsterdam offsets (11:00 winter, 12:00 summer).
function nextWeekdayWindow() {
  let day = DateTime.utc().plus({ days: 7 }).startOf("day"); while (day.weekday > 5) day = day.plus({ days: 1 });
  return { from: day.toJSDate(), to: day.endOf("day").toJSDate(), anchor: day.plus({ hours: 10 }) };
}
async function seededEvent() {
  const event = await db.eventType.findUniqueOrThrow({ where: { slug: "strategy-call" }, include: { durations: true } });
  return { event, duration: event.durations.find((item) => item.isDefault) ?? event.durations[0]! };
}
async function bookAsAnotherClient(event: { id: string; workspaceId: string; ownerId: string }, durationId: string, startAt: Date, durationMinutes: number, status = "CONFIRMED") {
  const id = randomUUID(); const endAt = DateTime.fromJSDate(startAt).plus({ minutes: durationMinutes }).toJSDate();
  await db.booking.create({ data: {
    id, workspaceId: event.workspaceId, eventTypeId: event.id, hostId: event.ownerId, durationId, durationMinutes,
    inviteeName: "Another client", inviteeEmail: `another-${id}@example.com`, inviteeTimeZone: "Europe/Amsterdam", startAt, endAt, status,
    idempotencyKey: randomUUID(), requestFingerprint: randomUUID(), capabilityVersion: randomUUID(), manageExpiresAt: DateTime.fromJSDate(endAt).plus({ days: 30 }).toJSDate(),
    occupancies: status === "CONFIRMED" ? { create: { workspaceId: event.workspaceId, hostId: event.ownerId, minuteStart: startAt } } : undefined,
  } });
  createdBookingIds.push(id); return { id, startAt, endAt };
}
const overlaps = (slot: { start: string; end: string }, range: { startAt: Date; endAt: Date }) => new Date(slot.start) < range.endAt && new Date(slot.end) > range.startAt;

describe("public availability comes from the database", () => {
  it("removes another client's confirmed appointment from the public slots with no provider busy time", async () => {
    const { event, duration } = await seededEvent(); const { from, to, anchor } = nextWeekdayWindow();
    const before = await listPublicSlots(event.slug, from, to, "UTC", noProviderBusy, duration.id);
    const target = before.find((slot) => new Date(slot.start).getTime() >= anchor.toMillis());
    expect(target, "the seeded schedule must offer a slot at or after the anchor").toBeDefined();
    const booking = await bookAsAnotherClient(event, duration.id, new Date(target!.start), duration.durationMinutes);
    const after = await listPublicSlots(event.slug, from, to, "UTC", noProviderBusy, duration.id);
    const displaced = before.filter((slot) => overlaps(slot, booking));
    expect(displaced.length).toBeGreaterThan(0);
    expect(after.some((slot) => slot.start === target!.start)).toBe(false);
    expect(after.some((slot) => overlaps(slot, booking))).toBe(false);
    expect(after.length).toBe(before.length - displaced.length);
    // The neighbours on either side of the appointment stay open.
    expect(after.some((slot) => new Date(slot.end).getTime() === booking.startAt.getTime())).toBe(true);
    expect(after.some((slot) => new Date(slot.start).getTime() === booking.endAt.getTime())).toBe(true);
  });

  it("does not hide slots for a cancelled appointment", async () => {
    const { event, duration } = await seededEvent(); const { from, to, anchor } = nextWeekdayWindow();
    const before = await listPublicSlots(event.slug, from, to, "UTC", noProviderBusy, duration.id);
    const target = before.find((slot) => new Date(slot.start).getTime() >= anchor.toMillis())!;
    await bookAsAnotherClient(event, duration.id, new Date(target.start), duration.durationMinutes, "CANCELLED");
    const after = await listPublicSlots(event.slug, from, to, "UTC", noProviderBusy, duration.id);
    expect(after.map((slot) => slot.start)).toEqual(before.map((slot) => slot.start));
  });

  it("keeps serving database availability, still hiding booked time, when the calendar provider fails", async () => {
    const { event, duration } = await seededEvent(); const { from, to, anchor } = nextWeekdayWindow();
    const before = await listPublicSlots(event.slug, from, to, "UTC", noProviderBusy, duration.id);
    const target = before.find((slot) => new Date(slot.start).getTime() >= anchor.toMillis())!;
    const booking = await bookAsAnotherClient(event, duration.id, new Date(target.start), duration.durationMinutes);
    const failing: CalendarService = { ...noProviderBusy, async getBusyIntervals() { throw Object.assign(new Error("Google is not connected"), { code: "GOOGLE_CALENDAR_RETRY" }); } };
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const slots = await listPublicSlots(event.slug, from, to, "UTC", failing, duration.id);
    const logged = write.mock.calls.map((call) => String(call[0])).join("");
    write.mockRestore();
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.some((slot) => overlaps(slot, booking))).toBe(false);
    expect(logged).toContain("provider_busy_unavailable"); expect(logged).toContain("GOOGLE_CALENDAR_RETRY");
  });

  it("adds provider busy time on top of the database when the provider does answer", async () => {
    const { event, duration } = await seededEvent(); const { from, to, anchor } = nextWeekdayWindow();
    const before = await listPublicSlots(event.slug, from, to, "UTC", noProviderBusy, duration.id);
    const target = before.find((slot) => new Date(slot.start).getTime() >= anchor.toMillis())!;
    const block = { start: new Date(target.start), end: new Date(target.end) };
    const external: CalendarService = { ...noProviderBusy, async getBusyIntervals() { return [block]; } };
    const slots = await listPublicSlots(event.slug, from, to, "UTC", external, duration.id);
    expect(slots.some((slot) => slot.start === target.start)).toBe(false);
    expect(slots.length).toBeLessThan(before.length);
  });
});
