import { describe, expect, it } from "vitest";
import type { Booking } from "./demo-data";
import { countLabel, dayKey, dayLabel, firstDayKey, groupByDay, monthCells, monthLabel, monthOf, sameMonth, shiftMonth } from "./bookings-calendar-state";

function booking(id: string, startsAt: string): Booking {
  return { id, eventTypeId: "event", invitee: `Client ${id}`, email: `${id}@example.com`, eventTitle: "Haircut", startsAt, dateLabel: "", timeLabel: "", duration: 30, timezone: "Europe/Amsterdam", organizerTimeZone: "Europe/Amsterdam", status: "confirmed", hostName: "Host", notificationStatus: "LOCAL_NO_EMAIL", answers: [] };
}

describe("bookings calendar state", () => {
  it("keys an instant by the studio's civil date, not the browser's or UTC", () => {
    expect(dayKey("2026-09-01T22:30:00.000Z", "Europe/Amsterdam")).toBe("2026-09-02");
    expect(dayKey("2026-09-01T22:30:00.000Z", "UTC")).toBe("2026-09-01");
    expect(dayKey(new Date("2026-01-01T03:00:00.000Z"), "America/Chicago")).toBe("2025-12-31");
  });

  it("lays out a month Monday-first, padded to whole weeks", () => {
    const september = monthCells({ year: 2026, month: 9 });
    expect(september).toHaveLength(35);
    expect(september.slice(0, 2)).toEqual([null, { key: "2026-09-01", day: 1 }]);
    expect(september.at(-5)).toEqual({ key: "2026-09-30", day: 30 });
    expect(september.slice(-4).every((cell) => cell === null)).toBe(true);
    const february = monthCells({ year: 2027, month: 2 });
    expect(february[0]).toEqual({ key: "2027-02-01", day: 1 });
    expect(february).toHaveLength(28);
    expect(monthCells({ year: 2028, month: 2 }).filter(Boolean)).toHaveLength(29);
  });

  it("steps months across year boundaries in both directions", () => {
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth({ year: 2026, month: 9 }, -21)).toEqual({ year: 2024, month: 12 });
    expect(shiftMonth({ year: 2026, month: 9 }, 15)).toEqual({ year: 2027, month: 12 });
    expect(sameMonth(monthOf("2026-09-19"), { year: 2026, month: 9 })).toBe(true);
    expect(firstDayKey({ year: 2027, month: 3 })).toBe("2027-03-01");
  });

  it("labels civil dates without applying any timezone shift", () => {
    expect(monthLabel({ year: 2026, month: 9 })).toBe("September 2026");
    expect(dayLabel("2026-09-01")).toBe("Tuesday, September 1, 2026");
    expect(dayLabel("2027-01-31")).toBe("Sunday, January 31, 2027");
    expect(countLabel(1)).toBe("1 booking");
    expect(countLabel(0)).toBe("0 bookings");
  });

  it("groups bookings by studio day in start order", () => {
    const groups = groupByDay([
      booking("late", "2026-09-02T15:00:00.000Z"),
      booking("night", "2026-09-01T22:30:00.000Z"),
      booking("early", "2026-09-02T07:00:00.000Z"),
      booking("first", "2026-09-01T08:00:00.000Z"),
    ], "Europe/Amsterdam");
    expect([...groups.keys()]).toEqual(["2026-09-01", "2026-09-02"]);
    expect(groups.get("2026-09-01")?.map((item) => item.id)).toEqual(["first"]);
    expect(groups.get("2026-09-02")?.map((item) => item.id)).toEqual(["night", "early", "late"]);
  });
});
