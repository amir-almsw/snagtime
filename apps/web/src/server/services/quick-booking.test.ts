import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { createBooking, listDayGaps, listPublicSlots } from "@/server/services/bookings";
import { ensureStudioQuickService, getEventTypeBySlug, listEventTypes, listPublicEventDirectory, QUICK_SLOT_SLUG } from "@/server/services/event-types";
import type { CalendarService } from "@/server/services/calendar";

const names = ["EMAIL_TOKEN_SECRET", "NEXT_PUBLIC_APP_URL", "EMAIL_REPLY_TO", "BOOKING_CAPABILITY_KEY_ID", "BOOKING_CAPABILITY_SECRET", "CALENDAR_PROVIDER"] as const;
const noProviderBusy: CalendarService = { async getBusyIntervals() { return []; }, async createBookingEvent() { return null; }, async updateBookingEvent() {}, async deleteBookingEvent() {} };
const createdBookingIds: string[] = [];

describe("hidden quick appointment service", () => {
  beforeEach(() => {
    process.env.EMAIL_TOKEN_SECRET = "quick-booking-secret-that-is-more-than-32-bytes-ok";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    process.env.EMAIL_REPLY_TO = "support@example.invalid";
    process.env.BOOKING_CAPABILITY_KEY_ID = "quick-booking-v1";
    process.env.BOOKING_CAPABILITY_SECRET = "quick-booking-capability-secret-long-enough-42";
    process.env.CALENDAR_PROVIDER = "local";
  });
  afterEach(async () => {
    if (createdBookingIds.length) await db.booking.deleteMany({ where: { id: { in: createdBookingIds.splice(0) } } });
    await db.eventDuration.deleteMany({ where: { eventType: { slug: QUICK_SLOT_SLUG } } });
    await db.eventType.deleteMany({ where: { slug: QUICK_SLOT_SLUG } });
    for (const name of names) delete process.env[name];
  });

  it("is created lazily, bookable by the studio, and invisible to clients", async () => {
    const event = await db.eventType.findFirstOrThrow({ where: { slug: "strategy-call" } });
    const quick = await ensureStudioQuickService(event.workspaceId, event.ownerId);
    expect(quick).toMatchObject({ name: "Quick appointment", durationMinutes: 15 });

    // Hidden from the Services page and the public directory, and refused by the public slug lookup.
    expect((await listEventTypes(event.workspaceId)).map((item) => item.id)).not.toContain(quick.id);
    expect((await listPublicEventDirectory()).map((item) => item.slug)).not.toContain(QUICK_SLOT_SLUG);
    await expect(getEventTypeBySlug(QUICK_SLOT_SLUG)).rejects.toMatchObject({ status: 404 });

    // The studio can still list and book its 15-minute slots through the internal path.
    const from = new Date(Date.now() + 7 * 86_400_000);
    const to = new Date(Date.now() + 14 * 86_400_000);
    const slots = await listPublicSlots(QUICK_SLOT_SLUG, from, to, "Europe/Amsterdam", noProviderBusy, quick.durationId, undefined, false, false, undefined, undefined, undefined, undefined, undefined, undefined, true);
    expect(slots.length).toBeGreaterThan(0);
    const slot = slots[0]!;
    const created = await createBooking(QUICK_SLOT_SLUG, { startAt: slot.start, inviteeName: "Walk In", inviteeEmail: "walk-in@example.com", inviteeTimeZone: "Europe/Amsterdam" }, `quick-booking-${randomUUID()}`, undefined, undefined, { allowInternalService: true, allowSecondActiveBooking: true, byStudio: true });
    createdBookingIds.push(created.booking.id);
    expect(created.booking).toMatchObject({ eventTypeId: quick.id, durationMinutes: 15, eventTypeName: "Quick appointment" });
  });

  it("lists a 15-minute gap between two bookings for a civil date", async () => {
    const event = await db.eventType.findFirstOrThrow({ where: { slug: "strategy-call" } });
    let day = DateTime.now().setZone("Europe/Amsterdam").plus({ days: 8 }).startOf("day");
    while (day.weekday > 5) day = day.plus({ days: 1 });
    const dateKey = day.toFormat("yyyy-LL-dd");
    const range = (time: string, minutes: number) => {
      const start = DateTime.fromISO(`${dateKey}T${time}:00`, { zone: "Europe/Amsterdam" }).toUTC();
      return { start: start.toJSDate(), end: start.plus({ minutes }).toJSDate() };
    };
    const a = range("13:15", 30); // 13:15-13:45
    const b = range("14:00", 45); // 14:00-14:45 -> 15-minute gap
    const ids: string[] = [];
    for (const [name, item] of [["a", a], ["b", b]] as const) {
      const id = randomUUID(); ids.push(id);
      await db.booking.create({ data: {
        id, workspaceId: event.workspaceId, eventTypeId: event.id, hostId: event.ownerId, durationId: null,
        durationMinutes: item === a ? 30 : 45, priceCents: 0, currency: "usd", bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
        inviteeName: `Gap ${name}`, inviteeEmail: `gap-${name}@example.com`, inviteeTimeZone: "Europe/Amsterdam",
        startAt: item.start, endAt: item.end, status: "CONFIRMED", idempotencyKey: randomUUID(), requestFingerprint: randomUUID(),
        capabilityVersion: randomUUID(), manageExpiresAt: new Date(),
      } });
    }
    try {
      const gaps = await listDayGaps(event.workspaceId, event.ownerId, dateKey);
      const between = gaps.find((gap) => Math.abs(new Date(gap.start).getTime() - a.end.getTime()) < 1000 && Math.abs(new Date(gap.end).getTime() - b.start.getTime()) < 1000);
      expect(between?.minutes).toBe(15);
    } finally {
      await db.booking.deleteMany({ where: { id: { in: ids } } });
    }
  });
});
