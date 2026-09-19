import type { Booking } from "./demo-data";

export type CalendarMonth = { year: number; month: number };
export type CalendarCell = { key: string; day: number } | null;

// Monday-first, the same order the availability editor uses for the studio's week.
export const weekdayHeadings = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const keyFormatters = new Map<string, Intl.DateTimeFormat>();
function keyFormatter(timeZone: string) {
  let formatter = keyFormatters.get(timeZone);
  if (!formatter) { formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }); keyFormatters.set(timeZone, formatter); }
  return formatter;
}

// The civil date (YYYY-MM-DD) of an instant in the studio's timezone. Bookings are stored as instants,
// so a 23:30 UTC appointment belongs to the next day in Amsterdam; grouping by this key keeps the grid
// honest about which day the client actually walks in.
export function dayKey(value: Date | string, timeZone: string) {
  const parts = keyFormatter(timeZone).formatToParts(typeof value === "string" ? new Date(value) : value);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function civilKey(year: number, month: number, day: number) { return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`; }
export function monthOf(key: string): CalendarMonth { return { year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) }; }
export function sameMonth(a: CalendarMonth, b: CalendarMonth) { return a.year === b.year && a.month === b.month; }
export function shiftMonth({ year, month }: CalendarMonth, delta: number): CalendarMonth { const index = year * 12 + (month - 1) + delta; return { year: Math.floor(index / 12), month: ((index % 12) + 12) % 12 + 1 }; }
export function firstDayKey({ year, month }: CalendarMonth) { return civilKey(year, month, 1); }

// Calendar facts about a civil date (its weekday, the month's length) do not depend on a timezone, so
// they are computed on UTC midnight of that date and never touch the studio zone. Leading and trailing
// blanks pad the grid to whole weeks.
export function monthCells({ year, month }: CalendarMonth): CalendarCell[] {
  const leading = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: CalendarCell[] = Array.from({ length: leading }, () => null);
  for (let day = 1; day <= length; day += 1) cells.push({ key: civilKey(year, month, day), day });
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

const monthFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
const dayFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" });
export function monthLabel({ year, month }: CalendarMonth) { return monthFormatter.format(Date.UTC(year, month - 1, 1)); }
export function dayLabel(key: string) { const { year, month } = monthOf(key); return dayFormatter.format(Date.UTC(year, month - 1, Number(key.slice(8, 10)))); }
export function countLabel(count: number) { return count === 1 ? "1 booking" : `${count} bookings`; }

// Bookings bucketed by studio day, each bucket in start order, so a day cell and the agenda read the
// same list without re-sorting.
export function groupByDay(bookings: Booking[], timeZone: string) {
  const groups = new Map<string, Booking[]>();
  for (const booking of [...bookings].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
    const key = dayKey(booking.startsAt, timeZone);
    const group = groups.get(key);
    if (group) group.push(booking); else groups.set(key, [booking]);
  }
  return groups;
}
