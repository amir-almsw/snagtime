import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { cancelBooking, createBooking, listPublicSlots, rescheduleBooking } from "@/server/services/bookings";
import { enqueueBookingReminder, processEmailOutbox, type EmailDelivery, type EmailProvider } from "@/server/services/notifications";

const HOUR = 60 * 60_000;
const workspaceIds: string[] = []; const userIds: string[] = [];
class CaptureProvider implements EmailProvider { messages: EmailDelivery[] = []; async send(message: EmailDelivery) { this.messages.push(message); } }
async function fixture(label: string) {
  const user = await db.user.create({ data: { email: `${label}-${randomUUID()}@example.com`, name: label, passwordHash: "test", emailVerifiedAt: new Date(), timeZone: "America/Chicago" } });
  const workspace = await db.workspace.create({ data: { name: `${label} workspace`, timeZone: "America/Chicago" } });
  await db.membership.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  const event = await db.eventType.create({ data: { workspaceId: workspace.id, ownerId: user.id, name: `${label} event`, slug: `${label}-${randomUUID()}`, locationType: "CUSTOM" } });
  workspaceIds.push(workspace.id); userIds.push(user.id);
  return { user, workspace, event };
}
async function confirmedBooking(owner: Awaited<ReturnType<typeof fixture>>, startAt: Date, extra: Record<string, unknown> = {}) {
  return db.booking.create({ data: {
    workspaceId: owner.workspace.id, eventTypeId: owner.event.id, hostId: owner.user.id, durationMinutes: 30,
    inviteeName: "Reminded Guest", inviteeEmail: "reminded@example.com", inviteeTimeZone: "America/Chicago",
    startAt, endAt: new Date(startAt.getTime() + 30 * 60_000), status: "CONFIRMED", eventTitleSnapshot: owner.event.name,
    capabilityVersion: randomUUID(), manageExpiresAt: new Date(startAt.getTime() + 30 * 24 * 60 * 60_000), ...extra,
  } });
}

describe("appointment reminders", () => {
  beforeEach(() => { process.env.EMAIL_TOKEN_SECRET = "reminder-test-secret-that-is-more-than-thirty-two-bytes"; process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000"; process.env.EMAIL_REPLY_TO = "support@example.invalid"; process.env.BOOKING_CAPABILITY_KEY_ID = "reminder-test-v1"; process.env.BOOKING_CAPABILITY_SECRET = "reminder-capability-secret-that-is-long-enough-9"; process.env.CALENDAR_PROVIDER = "local"; });
  afterEach(async () => { const owned = workspaceIds.splice(0); await db.booking.deleteMany({ where: { workspaceId: { in: owned } } }); await db.workspace.deleteMany({ where: { id: { in: owned } } }); await db.user.deleteMany({ where: { id: { in: userIds.splice(0) } } }); for (const name of ["EMAIL_TOKEN_SECRET","NEXT_PUBLIC_APP_URL","EMAIL_REPLY_TO","BOOKING_CAPABILITY_KEY_ID","BOOKING_CAPABILITY_SECRET","BOOKING_REMINDER_LEAD_HOURS","CALENDAR_PROVIDER"]) delete process.env[name]; });

  it("schedules the reminder exactly one lead time before the booked start when a booking is created", async () => {
    const from = new Date(Date.now() + 86_400_000); const to = new Date(Date.now() + 21 * 86_400_000);
    const slots = await listPublicSlots("strategy-call", from, to, "UTC");
    const slot = slots.find((item) => new Date(item.start).getTime() > Date.now() + 26 * HOUR); if (!slot) throw new Error("No seeded slot beyond the reminder lead window was available.");
    const created = await createBooking("strategy-call", { startAt: slot.start, inviteeName: "Created Guest", inviteeEmail: "created-reminder@example.com", inviteeTimeZone: "UTC" }, `reminder-create-${randomUUID()}`);
    try {
      const reminder = await db.emailOutbox.findFirstOrThrow({ where: { bookingId: created.booking.id, kind: "BOOKING_REMINDER" } });
      expect(reminder).toMatchObject({ status: "PENDING", recipientEmail: "created-reminder@example.com", bookingMutationVersion: 0 });
      expect(reminder.nextAttemptAt.getTime()).toBe(new Date(slot.start).getTime() - 24 * HOUR);
    } finally { await db.booking.delete({ where: { id: created.booking.id } }); }
  });

  it("delivers nothing before the lead window opens and delivers the manage-link reminder once it does", async () => {
    const owner = await fixture("reminder-window"); const startAt = new Date("2099-01-10T16:00:00Z");
    const booking = await confirmedBooking(owner, startAt);
    await db.$transaction((tx) => enqueueBookingReminder(tx, booking, new Date()));
    const provider = new CaptureProvider();
    await processEmailOutbox(owner.workspace.id, new Date(startAt.getTime() - 25 * HOUR), provider);
    expect(provider.messages).toHaveLength(0);
    expect(await db.emailOutbox.findFirstOrThrow({ where: { bookingId: booking.id, kind: "BOOKING_REMINDER" } })).toMatchObject({ status: "PENDING", attemptCount: 0 });
    await processEmailOutbox(owner.workspace.id, new Date(startAt.getTime() - 23 * HOUR), provider);
    expect(provider.messages).toHaveLength(1);
    expect(provider.messages[0]!.subject).toBe(`Reminder: ${owner.event.name}`);
    expect(provider.messages[0]!.text).toContain(`/manage/${booking.id}/reschedule#recovery=`);
    expect(await db.emailOutbox.findFirstOrThrow({ where: { bookingId: booking.id, kind: "BOOKING_REMINDER" } })).toMatchObject({ status: "COMPLETED" });
  });

  it("supersedes the pending reminder inside the cancellation transaction and never delivers it", async () => {
    const owner = await fixture("reminder-cancel"); const startAt = new Date("2099-02-10T16:00:00Z");
    const booking = await confirmedBooking(owner, startAt, { occupancies: { create: { workspaceId: owner.workspace.id, hostId: owner.user.id, minuteStart: startAt } } });
    await db.$transaction((tx) => enqueueBookingReminder(tx, booking, new Date()));
    await cancelBooking(booking.id, "Client called the shop");
    expect(await db.emailOutbox.findFirstOrThrow({ where: { bookingId: booking.id, kind: "BOOKING_REMINDER" } })).toMatchObject({ status: "SUPERSEDED", lastErrorCode: "REMINDER_SUPERSEDED" });
    const provider = new CaptureProvider();
    await processEmailOutbox(owner.workspace.id, new Date(startAt.getTime() - 23 * HOUR), provider);
    expect(provider.messages.some((message) => message.subject.startsWith("Reminder:"))).toBe(false);
  });

  it("replaces the reminder on reschedule so exactly one pending row targets the new time", async () => {
    const event = await db.eventType.findFirstOrThrow({ where: { slug: "strategy-call" }, include: { durations: true } }); const duration = event.durations[0]!; const bookingId = randomUUID();
    const startAt = new Date("2099-09-15T15:00:00Z");
    const booking = await db.booking.create({ data: {
      id: bookingId, workspaceId: event.workspaceId, eventTypeId: event.id, hostId: event.ownerId, durationId: duration.id, durationMinutes: duration.durationMinutes,
      inviteeName: "Rescheduled Guest", inviteeEmail: "rescheduled-reminder@example.com", inviteeTimeZone: "America/Chicago", startAt, endAt: new Date(startAt.getTime() + duration.durationMinutes * 60_000),
      status: "CONFIRMED", bookingWindowDays: 30000, eventTitleSnapshot: event.name, idempotencyKey: randomUUID(), requestFingerprint: randomUUID(), capabilityVersion: randomUUID(), manageExpiresAt: new Date("2099-10-15T00:00:00Z"),
      occupancies: { create: { workspaceId: event.workspaceId, hostId: event.ownerId, minuteStart: startAt } },
    } });
    try {
      await db.$transaction((tx) => enqueueBookingReminder(tx, booking, new Date()));
      const newStart = "2099-09-16T15:00:00.000Z";
      await rescheduleBooking(bookingId, newStart);
      const rows = await db.emailOutbox.findMany({ where: { bookingId, kind: "BOOKING_REMINDER" }, orderBy: { createdAt: "asc" } });
      expect(rows.filter((row) => row.status === "PENDING")).toHaveLength(1);
      expect(rows.find((row) => row.bookingMutationVersion === 0)).toMatchObject({ status: "SUPERSEDED", lastErrorCode: "REMINDER_SUPERSEDED" });
      const replacement = rows.find((row) => row.status === "PENDING")!;
      expect(replacement.bookingMutationVersion).toBe(1);
      expect(replacement.nextAttemptAt.getTime()).toBe(new Date(newStart).getTime() - 24 * HOUR);
    } finally { await db.booking.delete({ where: { id: bookingId } }); }
  });

  it("schedules no reminder for a booking made inside the lead window", async () => {
    const owner = await fixture("reminder-soon");
    const booking = await confirmedBooking(owner, new Date(Date.now() + 2 * HOUR));
    await db.$transaction((tx) => enqueueBookingReminder(tx, booking, new Date()));
    expect(await db.emailOutbox.count({ where: { bookingId: booking.id, kind: "BOOKING_REMINDER" } })).toBe(0);
    expect(await db.bookingRecoveryToken.count({ where: { bookingId: booking.id } })).toBe(0);
  });
});
