import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { createBooking, listPublicSlots } from "@/server/services/bookings";
import { BOOKING_REFERENCE_PATTERN, generateBookingReference, normalizeBookingReference } from "@/server/services/booking-reference";

describe("booking reference", () => {
  it("mints codes free of the glyphs people confuse when reading one aloud", () => {
    const codes = Array.from({ length: 300 }, () => generateBookingReference());
    for (const code of codes) expect(code).toMatch(BOOKING_REFERENCE_PATTERN);
    // 0/O, 1/I/L and U/V are the pairs that survive neither a phone call nor a retype.
    for (const code of codes) expect(code.slice(3)).not.toMatch(/[01OILUV]/);
    // Not a uniqueness proof -- just that the generator is not returning a constant.
    expect(new Set(codes).size).toBeGreaterThan(290);
  });

  it("accepts a reference the way a client actually retypes it", () => {
    const reference = generateBookingReference();
    const body = reference.slice(3);
    for (const typed of [reference, reference.toLowerCase(), body, body.toLowerCase(), ` ${reference} `, reference.replace("-", " "), reference.replace("-", ""), `${body.slice(0, 3)} ${body.slice(3)}`]) {
      expect(normalizeBookingReference(typed)).toBe(reference);
    }
  });

  it("returns empty for anything that could not be a reference, so it never reaches a query", () => {
    for (const rubbish of ["", "  ", "DV-", "DV-1234", "DV-12345678", "not a reference", "../../etc/passwd", "DV-OILU01", "'; DROP TABLE Booking; --"]) {
      expect(normalizeBookingReference(rubbish)).toBe("");
    }
  });
});

// The column is nullable so the fixtures across these suites can keep inserting Booking rows directly,
// which means the guarantee that every real client booking carries a code lives here rather than in the
// schema. Any future path that creates a booking for a person has to keep this passing.
describe("createBooking reference invariant", () => {
  const names = ["EMAIL_TOKEN_SECRET", "NEXT_PUBLIC_APP_URL", "EMAIL_REPLY_TO", "BOOKING_CAPABILITY_KEY_ID", "BOOKING_CAPABILITY_SECRET", "CALENDAR_PROVIDER"] as const;
  const created: string[] = [];
  beforeEach(() => {
    process.env.EMAIL_TOKEN_SECRET = "reference-secret-that-is-more-than-32-bytes-long";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    process.env.EMAIL_REPLY_TO = "support@example.invalid";
    process.env.BOOKING_CAPABILITY_KEY_ID = "reference-v1";
    process.env.BOOKING_CAPABILITY_SECRET = "reference-capability-secret-long-enough-to-pass";
    process.env.CALENDAR_PROVIDER = "local";
  });
  afterEach(async () => { await db.booking.deleteMany({ where: { id: { in: created.splice(0) } } }); for (const name of names) delete process.env[name]; });

  it("gives every booking a client makes a reference they can quote back", async () => {
    const from = new Date(Date.now() + 86_400_000); const to = new Date(Date.now() + 21 * 86_400_000);
    const slot = (await listPublicSlots("strategy-call", from, to, "Europe/Amsterdam"))[0];
    if (!slot) throw new Error("No open slot was available.");
    const result = await createBooking("strategy-call", { startAt: slot.start, inviteeName: "Reference Probe", inviteeEmail: `reference-${randomUUID()}@example.invalid`, inviteeTimeZone: "Europe/Amsterdam" }, `reference-${randomUUID()}`);
    created.push(result.booking.id);
    const stored = await db.booking.findUniqueOrThrow({ where: { id: result.booking.id }, select: { reference: true } });
    expect(stored.reference).toMatch(BOOKING_REFERENCE_PATTERN);
    expect(normalizeBookingReference(stored.reference!.toLowerCase())).toBe(stored.reference);
  });
});
