import { describe, expect, it } from "vitest";
import { availabilityInput } from "@/server/validation";
import { mapAvailability, toAvailability } from "./api-adapter";
import type { AvailabilityOverride } from "@/lib/contracts";
import { addTimeOff, availabilitySaveResultIsCurrent, canMutateAvailability, dayCountLabel, expandDateRange, pruneExpiredOverrides, rangeDays, removeTimeOff, shiftDateKey, timeOffRunLabel, timeOffRuns, timeOptions, todayKey, weekBounds, windowEndOptions, windowStartOptions } from "./availability-editor-state";

describe("availability editor safety state", () => {
  it("permits mutations only after the initial availability load succeeds", () => {
    expect(canMutateAvailability("loading")).toBe(false);
    expect(canMutateAvailability("error")).toBe(false);
    expect(canMutateAvailability("loaded")).toBe(true);
  });

  it("does not apply an older save response over concurrent edits", () => {
    expect(availabilitySaveResultIsCurrent(3, 3)).toBe(true);
    expect(availabilitySaveResultIsCurrent(3, 4)).toBe(false);
  });
});

describe("weekly window pick-lists", () => {
  it("offers every hour from 08:00 through a 22:00 close", () => {
    expect(windowStartOptions[0]).toBe("8:00 AM"); expect(windowStartOptions.at(-1)).toBe("9:00 PM"); expect(windowStartOptions).toHaveLength(14);
    expect(windowEndOptions[0]).toBe("9:00 AM"); expect(windowEndOptions.at(-1)).toBe("10:00 PM"); expect(windowEndOptions).toHaveLength(14);
    expect(windowEndOptions.slice(-5)).toEqual(["6:00 PM", "7:00 PM", "8:00 PM", "9:00 PM", "10:00 PM"]);
    expect(windowEndOptions).toContain("2:00 PM");
  });

  it("keeps a saved off-hour time selectable at its place in the list", () => {
    expect(timeOptions(windowEndOptions, "10:00 PM")).toBe(windowEndOptions);
    const withHalfHour = timeOptions(windowEndOptions, "9:30 PM");
    expect(withHalfHour.slice(-3)).toEqual(["9:00 PM", "9:30 PM", "10:00 PM"]);
    expect(withHalfHour).toHaveLength(15);
  });

  it("round-trips a 22:00 close through the API mapping and the server validator", () => {
    const names: ReadonlyArray<readonly [string, string]> = [["Monday", "Mon"], ["Tuesday", "Tue"], ["Wednesday", "Wed"], ["Thursday", "Thu"], ["Friday", "Fri"], ["Saturday", "Sat"], ["Sunday", "Sun"]];
    const days = names.map(([day, short], index) => ({ day, short, enabled: index === 0, windows: index === 0 ? [{ id: "w", start: "9:00 AM", end: "10:00 PM" }] : [] }));
    const schedule = toAvailability(days, "Europe/Amsterdam");
    expect(schedule.intervals).toEqual([{ dayOfWeek: 1, startMinute: 540, endMinute: 22 * 60 }]);
    expect(() => availabilityInput.parse(schedule)).not.toThrow();
    expect(mapAvailability(schedule)[0]!.windows[0]).toMatchObject({ start: "9:00 AM", end: "10:00 PM" });
  });
});

describe("time off ranges", () => {
  const off = (dateKey: string): AvailabilityOverride => ({ dateKey, isAvailable: false, startMinute: null, endMinute: null });
  const custom = (dateKey: string): AvailabilityOverride => ({ dateKey, isAvailable: true, startMinute: 600, endMinute: 900 });

  it("reads the studio's civil date and shifts it without the browser zone", () => {
    expect(todayKey("Europe/Amsterdam", new Date("2026-09-21T22:30:00Z"))).toBe("2026-09-22");
    expect(todayKey("UTC", new Date("2026-09-21T22:30:00Z"))).toBe("2026-09-21");
    expect(shiftDateKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDateKey("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("expands a range inclusively in either order and caps it at a year", () => {
    expect(expandDateRange("2026-10-05", "2026-10-07")).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(expandDateRange("2026-10-07", "2026-10-05")).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(rangeDays("2026-10-05", "2026-10-05")).toBe(1);
    expect(rangeDays("2026-10-05", "2027-10-06")).toBe(367);
    expect(expandDateRange("2026-10-05", "2027-10-06")).toEqual([]);
    expect(rangeDays("", "2026-10-05")).toBe(0);
    expect(rangeDays("2026-02-30", "2026-03-01")).toBe(0);
  });

  it("finds Monday-to-Sunday bounds for this week and the next", () => {
    expect(weekBounds("2026-09-23")).toEqual({ from: "2026-09-21", to: "2026-09-27" });
    expect(weekBounds("2026-09-27")).toEqual({ from: "2026-09-21", to: "2026-09-27" });
    expect(weekBounds("2026-09-21", 1)).toEqual({ from: "2026-09-28", to: "2026-10-04" });
  });

  it("adds a run of full days off, replacing custom hours and keeping dates already off", () => {
    const start = [custom("2026-10-06"), off("2026-10-07"), off("2026-10-20")];
    const result = addTimeOff(start, "2026-10-05", "2026-10-08");
    expect(result.filter((item) => item.dateKey === "2026-10-06")).toEqual([off("2026-10-06")]);
    expect(result.map((item) => item.dateKey).sort()).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-20"]);
    expect(result.every((item) => !item.isAvailable)).toBe(true);
    expect(addTimeOff(start, "", "2026-10-08")).toBe(start);
  });

  it("groups consecutive dates into runs, labels them, and removes a whole run at once", () => {
    const overrides = [off("2026-10-07"), off("2026-10-05"), off("2026-10-06"), off("2026-10-09"), custom("2026-10-08")];
    const runs = timeOffRuns(overrides);
    expect(runs.map(({ from, to, days }) => ({ from, to, days }))).toEqual([{ from: "2026-10-05", to: "2026-10-07", days: 3 }, { from: "2026-10-09", to: "2026-10-09", days: 1 }]);
    expect(timeOffRunLabel(runs[0]!, "2026-09-21")).toBe("Mon, Oct 5 – Wed, Oct 7");
    expect(timeOffRunLabel(runs[1]!, "2025-09-21")).toBe("Fri, Oct 9, 2026");
    expect(dayCountLabel(1)).toBe("1 day"); expect(dayCountLabel(3)).toBe("3 days");
    expect(removeTimeOff(overrides, runs[0]!).map((item) => item.dateKey)).toEqual(["2026-10-09", "2026-10-08"]);
  });

  it("drops rows dated before today on save", () => {
    expect(pruneExpiredOverrides([off("2026-09-20"), custom("2026-09-21"), off("2026-09-22")], "2026-09-21").map((item) => item.dateKey)).toEqual(["2026-09-21", "2026-09-22"]);
  });
});
