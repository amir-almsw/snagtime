import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { bookingEventDescription, googleCreateEventRequest, type CalendarBooking, type CalendarService } from "@/server/services/calendar";
import { enqueueBookingEmail, GOOGLE_INVITE_FALLBACK_MS, processEmailOutbox, type EmailDelivery, type EmailProvider } from "@/server/services/notifications";
import { processOutbox } from "@/server/services/outbox";

const bookingIds: string[] = [];
class CaptureProvider implements EmailProvider { messages: EmailDelivery[] = []; async send(message: EmailDelivery) { this.messages.push(message); } }
const noBusy = async () => [];
async function fixture(label: string, provider: string, status = "CONFIRMED", mutationVersion = 0) {
  const event = await db.eventType.findFirstOrThrow({ include: { durations: true } }); const duration = event.durations[0]!; const id = randomUUID(); bookingIds.push(id);
  const booking = await db.booking.create({ data: { id, workspaceId: event.workspaceId, eventTypeId: event.id, hostId: event.ownerId, durationId: duration.id, durationMinutes: duration.durationMinutes, inviteeName: label, inviteeEmail: `${label.toLowerCase().replaceAll(/[^a-z]/g, "-")}@example.invalid`, inviteeTimeZone: "UTC", startAt: new Date("2099-11-01T15:00:00Z"), endAt: new Date("2099-11-01T15:30:00Z"), status, calendarProviderSnapshot: provider, eventTitleSnapshot: event.name, locationTypeSnapshot: "CUSTOM", idempotencyKey: randomUUID(), requestFingerprint: randomUUID(), capabilityVersion: randomUUID(), manageExpiresAt: new Date("2099-12-01T00:00:00Z"), mutationVersion } });
  return { booking, event };
}
function inviteeRow(bookingId: string, kind: string) { return db.emailOutbox.findFirstOrThrow({ where: { bookingId, kind, idempotencyKey: { startsWith: `email:booking:${kind}:` } } }); }
function organizerRow(bookingId: string) { return db.emailOutbox.findFirstOrThrow({ where: { bookingId, idempotencyKey: { startsWith: "email:booking:organizer:" } } }); }

describe("google invitation as the client confirmation", () => {
  beforeEach(() => { process.env.EMAIL_TOKEN_SECRET = "single-invite-secret-that-is-more-than-thirty-two-bytes"; process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000"; process.env.EMAIL_REPLY_TO = "support@example.invalid"; });
  afterEach(async () => { await db.booking.deleteMany({ where: { id: { in: bookingIds.splice(0) } } }); for (const name of ["EMAIL_TOKEN_SECRET","NEXT_PUBLIC_APP_URL","EMAIL_REPLY_TO"]) delete process.env[name]; });

  it("defers the invitee confirmation for google bookings and supersedes it once the invite is sent, leaving exactly one client message", async () => {
    const { booking } = await fixture("Google Wins", "google"); const now = new Date();
    await db.$transaction((tx) => enqueueBookingEmail(tx, booking, "BOOKING_CONFIRMED", now));
    const deferred = await inviteeRow(booking.id, "BOOKING_CONFIRMED");
    expect(deferred.nextAttemptAt.getTime()).toBe(now.getTime() + GOOGLE_INVITE_FALLBACK_MS);
    const organizer = await organizerRow(booking.id);
    expect(organizer.nextAttemptAt.getTime()).toBeLessThanOrEqual(now.getTime() + 1_000);
    await db.integrationOutbox.create({ data: { workspaceId: booking.workspaceId, bookingId: booking.id, kind: "CALENDAR_CREATE", idempotencyKey: `invite:create:${booking.id}` } });
    const calendar: CalendarService = { getBusyIntervals: noBusy, async createBookingEvent() { return { eventId: `invite-${booking.id}`, etag: "v1", disposition: "created" }; }, async updateBookingEvent() {}, async deleteBookingEvent() {} };
    await processOutbox(booking.workspaceId, booking.id, new Date(), calendar);
    expect(await db.integrationOutbox.findFirstOrThrow({ where: { bookingId: booking.id } })).toMatchObject({ status: "COMPLETED" });
    expect(await inviteeRow(booking.id, "BOOKING_CONFIRMED")).toMatchObject({ status: "SUPERSEDED", lastErrorCode: "GOOGLE_INVITE_SENT" });
    const provider = new CaptureProvider();
    await processEmailOutbox(booking.workspaceId, new Date(now.getTime() + GOOGLE_INVITE_FALLBACK_MS + 60_000), provider);
    expect(provider.messages.some((message) => message.recipientEmail === booking.inviteeEmail)).toBe(false);
    expect(provider.messages.some((message) => message.subject.startsWith("New booking:"))).toBe(true);
  });

  it("delivers the fallback confirmation with a manage link when the google invite cannot be created", async () => {
    const { booking } = await fixture("Google Broken", "google"); const now = new Date();
    await db.$transaction((tx) => enqueueBookingEmail(tx, booking, "BOOKING_CONFIRMED", now));
    await db.integrationOutbox.create({ data: { workspaceId: booking.workspaceId, bookingId: booking.id, kind: "CALENDAR_CREATE", idempotencyKey: `invite:broken:${booking.id}` } });
    const calendar: CalendarService = { getBusyIntervals: noBusy, async createBookingEvent() { throw new Error("GOOGLE_UNAVAILABLE"); }, async updateBookingEvent() {}, async deleteBookingEvent() {} };
    await processOutbox(booking.workspaceId, booking.id, new Date(), calendar);
    expect(await db.integrationOutbox.findFirstOrThrow({ where: { bookingId: booking.id } })).toMatchObject({ status: "RETRY", lastErrorCode: "PROVIDER_OPERATION_FAILED" });
    expect(await inviteeRow(booking.id, "BOOKING_CONFIRMED")).toMatchObject({ status: "PENDING" });
    const provider = new CaptureProvider();
    await processEmailOutbox(booking.workspaceId, new Date(now.getTime() + GOOGLE_INVITE_FALLBACK_MS + 60_000), provider);
    const fallback = provider.messages.find((message) => message.recipientEmail === booking.inviteeEmail);
    expect(fallback!.text).toContain(`/manage/${booking.id}/reschedule#recovery=`);
  });

  it("keeps the local provider's confirmation immediate and never supersedes it", async () => {
    const { booking } = await fixture("Local Demo", "local"); const now = new Date();
    await db.$transaction((tx) => enqueueBookingEmail(tx, booking, "BOOKING_CONFIRMED", now));
    expect((await inviteeRow(booking.id, "BOOKING_CONFIRMED")).nextAttemptAt.getTime()).toBeLessThanOrEqual(now.getTime() + 1_000);
    await db.integrationOutbox.create({ data: { workspaceId: booking.workspaceId, bookingId: booking.id, kind: "CALENDAR_CREATE", idempotencyKey: `invite:local:${booking.id}` } });
    const calendar: CalendarService = { getBusyIntervals: noBusy, async createBookingEvent() { return { eventId: `local-${booking.id}`, etag: "v1", disposition: "created" }; }, async updateBookingEvent() {}, async deleteBookingEvent() {} };
    await processOutbox(booking.workspaceId, booking.id, new Date(), calendar);
    expect(await db.integrationOutbox.findFirstOrThrow({ where: { bookingId: booking.id } })).toMatchObject({ status: "COMPLETED" });
    const provider = new CaptureProvider();
    await processEmailOutbox(booking.workspaceId, new Date(now.getTime() + 1_000), provider);
    expect(provider.messages.some((message) => message.recipientEmail === booking.inviteeEmail)).toBe(true);
  });

  it("supersedes the deferred reschedule and cancellation copies once google acknowledges the change", async () => {
    const { booking } = await fixture("Google Lifecycle", "google", "CONFIRMED", 1); const now = new Date();
    await db.booking.update({ where: { id: booking.id }, data: { externalCalendarEventId: `invite-${booking.id}` } });
    await db.$transaction((tx) => enqueueBookingEmail(tx, { ...booking, mutationVersion: 1 }, "BOOKING_RESCHEDULED", now));
    await db.integrationOutbox.create({ data: { workspaceId: booking.workspaceId, bookingId: booking.id, kind: "CALENDAR_UPDATE", bookingMutationVersion: 1, idempotencyKey: `invite:update:${booking.id}` } });
    const calendar: CalendarService = { getBusyIntervals: noBusy, async createBookingEvent() { return null; }, async updateBookingEvent() { return { eventId: `invite-${booking.id}`, etag: "v2" }; }, async deleteBookingEvent() { return { eventId: `invite-${booking.id}`, providerAbsent: false }; } };
    await processOutbox(booking.workspaceId, booking.id, new Date(), calendar);
    expect(await inviteeRow(booking.id, "BOOKING_RESCHEDULED")).toMatchObject({ status: "SUPERSEDED", lastErrorCode: "GOOGLE_INVITE_SENT" });
    await db.booking.update({ where: { id: booking.id }, data: { status: "CANCELLED", mutationVersion: 2 } });
    await db.$transaction((tx) => enqueueBookingEmail(tx, { ...booking, mutationVersion: 2 }, "BOOKING_CANCELLED", now));
    await db.integrationOutbox.create({ data: { workspaceId: booking.workspaceId, bookingId: booking.id, kind: "CALENDAR_DELETE", idempotencyKey: `invite:delete:${booking.id}` } });
    await processOutbox(booking.workspaceId, booking.id, new Date(), calendar);
    expect(await inviteeRow(booking.id, "BOOKING_CANCELLED")).toMatchObject({ status: "SUPERSEDED", lastErrorCode: "GOOGLE_INVITE_SENT" });
  });

  it("writes the manage link, custom answers, and the decline warning into the calendar event body", async () => {
    const { booking, event } = await fixture("Event Body", "google"); const now = new Date();
    await db.bookingAnswer.create({ data: { bookingId: booking.id, questionLabel: "Phone", valueJson: JSON.stringify("+1 555 0100") } });
    await db.$transaction((tx) => enqueueBookingEmail(tx, booking, "BOOKING_CONFIRMED", now));
    const hydrated = await db.booking.findUniqueOrThrow({ where: { id: booking.id }, include: { eventType: true, host: { select: { id: true, name: true, email: true, timeZone: true } } } }) as CalendarBooking;
    const description = await bookingEventDescription(hydrated, now);
    expect(description).toContain("Phone: +1 555 0100");
    expect(description).toContain(`/manage/${booking.id}/reschedule#recovery=`);
    expect(description).toContain("does NOT cancel the appointment");
    const request = googleCreateEventRequest("primary", `invite-${booking.id}`, hydrated, description);
    expect(request.requestBody.description).toBe(description);
    expect(request.sendUpdates).toBe("all");
    expect(request.requestBody.summary).toBe(`${event.name} with ${booking.inviteeName}`);
  });
});
