import { monthLabel, monthOf } from "./bookings-calendar-state";

// The date strip in the booking and reschedule pickers lists available days only, so the seven days
// on screen can cross a month boundary with nothing between them to say so: "27, 28, 2, 3" reads as
// one run of days. The band above the strip therefore names every month those dates touch --
// "November 2026", or "November 2026 – December 2026" when the strip straddles a change of month --
// and each chip repeats its own month under the day number.
export function bookingMonthLabel(keys: string[]) {
  const labels: string[] = [];
  for (const key of keys) {
    const label = monthLabel(monthOf(key));
    if (labels.at(-1) !== label) labels.push(label);
  }
  return labels.join(" – ");
}

const chipMonthFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short" });

// A date key is already a civil date in the client's own timezone, so its month is read off that date
// rather than off any instant -- noon UTC keeps the formatter on the day the key names.
export function bookingChipMonth(key: string) {
  const { year, month } = monthOf(key);
  return chipMonthFormatter.format(Date.UTC(year, month - 1, Number(key.slice(8, 10))));
}
