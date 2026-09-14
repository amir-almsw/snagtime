import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db";
import { renderEmailHtml, renderEmailText, safeAccent } from "@/server/services/email-template";
import { enqueueBookingEmail, failureCode, processEmailOutbox, type EmailDelivery, type EmailProvider } from "@/server/services/notifications";

const brand = { name: "Dvision Studio", accentColor: "#2563EB", footerText: "Herengracht 1, Amsterdam" };
const body = { preheader: "Sunday at 14:00", eyebrow: "Appointment confirmed", heading: "You’re booked in", intro: "See you then.", details: [{ label: "Service", value: "Master Haircut" }], action: { label: "Reschedule or cancel", href: "https://book.example.invalid/manage/abc#recovery=tok" }, note: "Reply any time." };

const bookingIds: string[] = [];
class CaptureProvider implements EmailProvider { messages: EmailDelivery[] = []; async send(message: EmailDelivery) { this.messages.push(message); } }
async function seed(overrides: Partial<{ inviteeName: string; reference: string; status: string; startAt: Date }> = {}) {
  const event = await db.eventType.findFirstOrThrow({ include: { durations: true } }); const duration = event.durations[0]!; const id = randomUUID(); bookingIds.push(id);
  return db.booking.create({ data: {
    id, reference: overrides.reference ?? `DV-${randomUUID().slice(0, 6).toUpperCase()}`,
    workspaceId: event.workspaceId, eventTypeId: event.id, hostId: event.ownerId, durationId: duration.id, durationMinutes: 35,
    inviteeName: overrides.inviteeName ?? "Sam Visser", inviteeEmail: `template-${randomUUID()}@example.invalid`, inviteeTimeZone: "Europe/Amsterdam",
    startAt: overrides.startAt ?? new Date("2099-04-02T12:00:00Z"), endAt: new Date("2099-04-02T12:35:00Z"), status: overrides.status ?? "CONFIRMED",
    eventTitleSnapshot: "Master Haircut", locationTypeSnapshot: "IN_PERSON", locationValueSnapshot: "Herengracht 1, Amsterdam",
    idempotencyKey: randomUUID(), requestFingerprint: randomUUID(), capabilityVersion: randomUUID(), manageExpiresAt: new Date("2099-12-01T00:00:00Z"),
  } });
}
async function deliver(bookingId: string, kind: "BOOKING_CONFIRMED" | "BOOKING_RESCHEDULED" | "BOOKING_CANCELLED", inviteeEmail: string) {
  const booking = await db.booking.findUniqueOrThrow({ where: { id: bookingId } });
  await db.$transaction((tx) => enqueueBookingEmail(tx, booking, kind));
  const provider = new CaptureProvider(); await processEmailOutbox(booking.workspaceId, new Date(), provider);
  return provider.messages.find((message) => message.recipientEmail === inviteeEmail.toLowerCase())!;
}

describe("client email templates", () => {
  beforeEach(() => { process.env.EMAIL_TOKEN_SECRET = "template-test-secret-that-is-more-than-thirty-two-b"; process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000"; process.env.EMAIL_REPLY_TO = "support@example.invalid"; });
  afterEach(async () => { await db.booking.deleteMany({ where: { id: { in: bookingIds.splice(0) } } }); for (const name of ["EMAIL_TOKEN_SECRET","NEXT_PUBLIC_APP_URL","EMAIL_REPLY_TO"]) delete process.env[name]; });

  it("emits a complete document whose every part also survives in the plain-text alternative", () => {
    const html = renderEmailHtml(brand, body); const text = renderEmailText(brand, body);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    for (const fragment of [body.heading, body.intro, "Master Haircut", body.action.href, body.note, brand.footerText]) {
      expect(text).toContain(fragment);
      expect(html).toContain(fragment);
    }
    // Without a preheader the inbox preview line repeats the header wordmark on every message.
    expect(html).toContain(body.preheader);
  });

  it("escapes anything a client typed before it reaches the markup", () => {
    const hostile = { ...body, heading: '</td><script>alert("x")</script>', details: [{ label: "Service", value: "Cut & Shave <b>" }] };
    const html = renderEmailHtml(brand, hostile);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Cut &amp; Shave &lt;b&gt;");
  });

  it("falls back to the default accent rather than writing an unvalidated colour into a style attribute", () => {
    expect(safeAccent("#123ABC")).toBe("#123ABC");
    for (const bad of ["red;}</style><script>", "#12345", "", null, undefined]) expect(safeAccent(bad)).toBe("#C11427");
  });

  it("carries the appointment, the reference and the manage link in both parts of a confirmation", async () => {
    const booking = await seed({ reference: "DV-4K7Q2M" });
    const message = await deliver(booking.id, "BOOKING_CONFIRMED", booking.inviteeEmail);
    for (const part of [message.text, message.html!]) {
      expect(part).toContain("Master Haircut");
      expect(part).toContain("Herengracht 1, Amsterdam");
      expect(part).toContain("35 minutes");
      expect(part).toContain("DV-4K7Q2M");
      expect(part).toContain(`/manage/${booking.id}/reschedule#recovery=`);
    }
    expect(message.text).toContain("Sam,");
  });

  it("escapes a hostile name through the whole delivery path, not just the template unit", async () => {
    const booking = await seed({ inviteeName: '<img src=x onerror="alert(1)">' });
    const message = await deliver(booking.id, "BOOKING_CONFIRMED", booking.inviteeEmail);
    expect(message.html).not.toContain("<img");
    expect(message.html).toContain("&lt;img");
  });

  it("points a cancellation at booking again instead of a manage link for an appointment that is gone", async () => {
    const booking = await seed();
    const message = await deliver(booking.id, "BOOKING_CANCELLED", booking.inviteeEmail);
    expect(message.text).toContain("canceled");
    expect(message.text).toContain("http://localhost:3000/book");
    expect(message.text).not.toContain("/reschedule#recovery=");
    expect(message.html).not.toContain("/reschedule#recovery=");
  });

  it("says the appointment moved, in the words the reschedule notice is checked for", async () => {
    const booking = await seed();
    const message = await deliver(booking.id, "BOOKING_RESCHEDULED", booking.inviteeEmail);
    expect(message.text).toContain("moved");
    expect(message.html).toContain("moved");
  });

  // The 2026-09-13 outage in one test: the worker could not read WorkspaceBranding, and the whole
  // confirmation died with it. Branding is decoration and must degrade, not block.
  it("still delivers when the branding read is refused", async () => {
    const booking = await seed();
    const denied = Object.assign(new Error("permission denied"), { meta: { code: "42501" } });
    const spy = vi.spyOn(db.workspace, "findUnique").mockRejectedValue(denied);
    try {
      const message = await deliver(booking.id, "BOOKING_CONFIRMED", booking.inviteeEmail);
      expect(message.text).toContain("Master Haircut");
      expect(message.text).toContain(`/manage/${booking.id}/reschedule#recovery=`);
      expect(message.html).toContain("Herengracht 1, Amsterdam");
    } finally { spy.mockRestore(); }
  });

  it("reduces a failure to a class identifier, never a message that could quote booking data", () => {
    expect(failureCode(Object.assign(new Error("permission denied for table X"), { meta: { code: "42501" } }))).toBe("42501");
    expect(failureCode(Object.assign(new Error("raw query failed"), { code: "P2010" }))).toBe("P2010");
    expect(failureCode(new TypeError("sam.visser@example.invalid is not a function"))).toBe("TypeError");
    for (const value of [null, undefined, "a string", 42]) expect(failureCode(value)).toBe("UNKNOWN");
  });
});
