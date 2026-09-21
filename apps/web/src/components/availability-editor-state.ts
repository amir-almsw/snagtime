import type { AvailabilityOverride } from "@/lib/contracts";
import { timeToMinutes } from "./api-adapter";

export type AvailabilityLoadState = "loading" | "loaded" | "error";

export function canMutateAvailability(loadState: AvailabilityLoadState) {
  return loadState === "loaded";
}

export function availabilitySaveResultIsCurrent(submittedRevision: number, currentRevision: number) {
  return submittedRevision === currentRevision;
}

// Hourly pick-lists for the weekly windows. The studio opens no earlier than 08:00 and closes no later
// than 22:00, so a window may start at any hour through 21:00 and end at any hour through 22:00.
const hourLabel = (hour: number) => `${hour % 12 || 12}:00 ${hour >= 12 ? "PM" : "AM"}`;
export const windowStartOptions: readonly string[] = Array.from({ length: 14 }, (_, index) => hourLabel(8 + index));
export const windowEndOptions: readonly string[] = Array.from({ length: 14 }, (_, index) => hourLabel(9 + index));

// A saved window that is not on the hour (written through the API, or by an earlier release) stays in
// the list at its chronological place, so the select never shows a time other than the one on record.
export function timeOptions(options: readonly string[], current: string) {
  if (options.includes(current)) return options;
  return [...options, current].sort((left, right) => timeToMinutes(left) - timeToMinutes(right));
}

// ---- Time off ----------------------------------------------------------------------------------
// Override date keys are civil dates (YYYY-MM-DD) in the studio timezone. Arithmetic on them runs on
// UTC midnight of that date, as the bookings calendar does, so the browser's own zone never leaks in.
const DAY_MS = 86_400_000;
const toUtc = (key: string) => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
export const isDateKey = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(toUtc(value)).toISOString().slice(0, 10) === value;

export function todayKey(timeZone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function shiftDateKey(key: string, days: number) { return new Date(toUtc(key) + days * DAY_MS).toISOString().slice(0, 10); }

// One row per date, so a range is capped at a year: a mistyped year must not turn into thousands of rows.
export const MAX_TIME_OFF_DAYS = 366;
export function rangeDays(from: string, to: string) {
  if (!isDateKey(from) || !isDateKey(to)) return 0;
  return Math.abs(Math.round((toUtc(to) - toUtc(from)) / DAY_MS)) + 1;
}
export function expandDateRange(from: string, to: string): string[] {
  const days = rangeDays(from, to);
  if (days === 0 || days > MAX_TIME_OFF_DAYS) return [];
  const start = toUtc(from) <= toUtc(to) ? from : to;
  return Array.from({ length: days }, (_, index) => shiftDateKey(start, index));
}
// Monday-to-Sunday bounds of the week holding `anchor`, or a later week.
export function weekBounds(anchor: string, weeksAhead = 0) {
  const monday = shiftDateKey(anchor, -((new Date(toUtc(anchor)).getUTCDay() + 6) % 7) + weeksAhead * 7);
  return { from: monday, to: shiftDateKey(monday, 6) };
}

// Adds a full-day off row for every date in the range. Time off wins: a date that had custom hours
// loses them, and a date that was already off keeps its row, so no date ends up listed twice.
export function addTimeOff(overrides: AvailabilityOverride[], from: string, to: string): AvailabilityOverride[] {
  const dates = expandDateRange(from, to);
  if (!dates.length) return overrides;
  const blocked = new Set(dates);
  const kept = overrides.filter((item) => !item.isAvailable || !blocked.has(item.dateKey));
  const alreadyOff = new Set(kept.filter((item) => !item.isAvailable).map((item) => item.dateKey));
  return [...kept, ...dates.filter((date) => !alreadyOff.has(date)).map((dateKey) => ({ dateKey, isAvailable: false, startMinute: null, endMinute: null }))];
}

// Consecutive off dates read back as one run, so a week's holiday is one row with one remove button.
export type TimeOffRun = { from: string; to: string; days: number; dateKeys: string[] };
export function timeOffRuns(overrides: AvailabilityOverride[]): TimeOffRun[] {
  const dates = [...new Set(overrides.filter((item) => !item.isAvailable && isDateKey(item.dateKey)).map((item) => item.dateKey))].sort();
  const runs: TimeOffRun[] = [];
  for (const date of dates) {
    const run = runs.at(-1);
    if (run && shiftDateKey(run.to, 1) === date) { run.to = date; run.days += 1; run.dateKeys.push(date); }
    else runs.push({ from: date, to: date, days: 1, dateKeys: [date] });
  }
  return runs;
}
export function removeTimeOff(overrides: AvailabilityOverride[], run: TimeOffRun) {
  const dates = new Set(run.dateKeys);
  return overrides.filter((item) => item.isAvailable || !dates.has(item.dateKey));
}

// Rows dated before today can no longer affect a booking (minimum notice already hides the past), so
// the editor drops them on save instead of letting the lists fill with history.
export function pruneExpiredOverrides(overrides: AvailabilityOverride[], today: string) {
  return overrides.filter((item) => item.dateKey >= today);
}

const dayFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const dayYearFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });
export function dateKeyLabel(key: string, withYear = false) { return (withYear ? dayYearFormatter : dayFormatter).format(toUtc(key)); }
export function timeOffRunLabel(run: TimeOffRun, today: string) {
  const withYear = run.to.slice(0, 4) !== today.slice(0, 4);
  return run.days === 1 ? dateKeyLabel(run.from, withYear) : `${dateKeyLabel(run.from, withYear)} – ${dateKeyLabel(run.to, withYear)}`;
}
export function dayCountLabel(days: number) { return days === 1 ? "1 day" : `${days} days`; }
