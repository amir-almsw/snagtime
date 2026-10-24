import { describe, expect, it } from "vitest";
import { bookingChipMonth, bookingMonthLabel } from "./booking-month";

describe("booking month labels", () => {
  it("names the month a strip inside one month belongs to", () => {
    expect(bookingMonthLabel(["2026-11-03", "2026-11-04", "2026-11-09"])).toBe("November 2026");
  });

  it("names both months when the visible week straddles a boundary", () => {
    expect(bookingMonthLabel(["2026-11-27", "2026-11-28", "2026-12-02"])).toBe("November 2026 – December 2026");
  });

  it("keeps each year on either side of a new year", () => {
    expect(bookingMonthLabel(["2026-12-30", "2027-01-04"])).toBe("December 2026 – January 2027");
  });

  it("labels an empty strip with nothing rather than a stray separator", () => {
    expect(bookingMonthLabel([])).toBe("");
  });

  it("abbreviates the month of a single chip", () => {
    expect(bookingChipMonth("2026-11-03")).toBe("Nov");
    expect(bookingChipMonth("2027-01-31")).toBe("Jan");
    expect(bookingChipMonth("2026-09-01")).toBe("Sep");
  });
});
