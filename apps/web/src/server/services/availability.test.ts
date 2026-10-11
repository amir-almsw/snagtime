import { describe, expect, it } from "vitest";
import { generateSlots, mergeBusyIntervals } from "@/server/services/availability";

const eventType = {
  durationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minimumNoticeMinutes: 0,
  bookingWindowDays: 30,
};

describe("availability slot generation", () => {
  it("normalizes overlapping busy ranges once without changing boundary semantics", () => {
    expect(mergeBusyIntervals([
      { start: new Date("2026-08-24T10:15:00Z"), end: new Date("2026-08-24T10:45:00Z") },
      { start: new Date("2026-08-24T10:00:00Z"), end: new Date("2026-08-24T10:30:00Z") },
      { start: new Date("2026-08-24T10:45:00Z"), end: new Date("2026-08-24T11:00:00Z") },
      { start: new Date("invalid"), end: new Date("2026-08-24T12:00:00Z") },
    ])).toEqual([{ start: new Date("2026-08-24T10:00:00Z"), end: new Date("2026-08-24T11:00:00Z") }]);
  });

  // Slots step 45 minutes from the interval's start whatever the service takes: a 30-minute service in a
  // 09:00-11:00 window gives 09:00, 09:45 and 10:30, and 10:30 only because it still ends by 11:00.
  it("expands weekly availability into deterministic UTC slots on the 45-minute grid", () => {
    const slots = generateSlots({
      eventType,
      schedule: { timeZone: "America/Chicago", intervals: [{ dayOfWeek: 1, startMinute: 9 * 60, endMinute: 11 * 60 }] },
      busy: [],
      from: new Date("2026-08-24T00:00:00.000Z"),
      to: new Date("2026-08-25T00:00:00.000Z"),
      now: new Date("2026-08-20T00:00:00.000Z"),
      outputTimeZone: "America/New_York",
    });
    expect(slots.map((slot) => slot.start)).toEqual([
      "2026-08-24T14:00:00.000Z",
      "2026-08-24T14:45:00.000Z",
      "2026-08-24T15:30:00.000Z",
    ]);
    expect(slots.every((slot) => slot.timeZone === "America/New_York")).toBe(true);
  });

  it("removes overlaps including configured buffers", () => {
    const slots = generateSlots({
      eventType: { ...eventType, bufferBeforeMinutes: 15, bufferAfterMinutes: 15 },
      schedule: { timeZone: "UTC", intervals: [{ dayOfWeek: 1, startMinute: 9 * 60, endMinute: 12 * 60 }] },
      busy: [{ start: new Date("2026-08-24T10:00:00.000Z"), end: new Date("2026-08-24T10:30:00.000Z") }],
      from: new Date("2026-08-24T00:00:00.000Z"),
      to: new Date("2026-08-25T00:00:00.000Z"),
      now: new Date("2026-08-20T00:00:00.000Z"),
      outputTimeZone: "UTC",
    });
    // 09:45 falls to its after-buffer (occupied until 10:30) and 10:30 to its before-buffer (from 10:15).
    expect(slots.map((slot) => slot.start)).toEqual(["2026-08-24T09:00:00.000Z", "2026-08-24T11:15:00.000Z"]);
  });

  it("uses date overrides and honors time off instead of weekly hours", () => {
    const slots = generateSlots({
      eventType,
      schedule: { timeZone: "UTC", intervals: [{ dayOfWeek: 1, startMinute: 540, endMinute: 600 }], overrides: [
        { dateKey: "2026-08-24", isAvailable: false },
        { dateKey: "2026-08-25", isAvailable: true, startMinute: 600, endMinute: 630 },
      ] },
      busy: [], from: new Date("2026-08-24T00:00:00Z"), to: new Date("2026-08-26T00:00:00Z"),
      now: new Date("2026-08-20T00:00:00Z"), outputTimeZone: "UTC",
    });
    expect(slots.map((slot) => slot.start)).toEqual(["2026-08-25T10:00:00.000Z"]);
  });

  // Time off for part of a day is an unavailable override that names its hours: it is cut out of
  // whatever the day's hours would otherwise be, whether those are the weekly hours or custom hours.
  it("cuts an hour block out of the day's weekly hours and out of a custom-hours override", () => {
    const block = { dateKey: "2026-08-24", isAvailable: false, startMinute: 10 * 60, endMinute: 11 * 60 };
    const weekly = generateSlots({
      eventType,
      schedule: { timeZone: "UTC", intervals: [{ dayOfWeek: 1, startMinute: 9 * 60, endMinute: 12 * 60 }], overrides: [block] },
      busy: [], from: new Date("2026-08-24T00:00:00Z"), to: new Date("2026-08-25T00:00:00Z"),
      now: new Date("2026-08-20T00:00:00Z"), outputTimeZone: "UTC",
    });
    const custom = generateSlots({
      eventType,
      schedule: { timeZone: "UTC", intervals: [], overrides: [block, { dateKey: "2026-08-24", isAvailable: true, startMinute: 9 * 60, endMinute: 12 * 60 }] },
      busy: [], from: new Date("2026-08-24T00:00:00Z"), to: new Date("2026-08-25T00:00:00Z"),
      now: new Date("2026-08-20T00:00:00Z"), outputTimeZone: "UTC",
    });
    // 09:00-12:00 in 30-minute slots on the 45-minute grid, minus the 10:00-11:00 block.
    expect(weekly.map((slot) => slot.start)).toEqual(["2026-08-24T09:00:00.000Z", "2026-08-24T11:00:00.000Z"]);
    expect(custom.map((slot) => slot.start)).toEqual(weekly.map((slot) => slot.start));
  });
});
