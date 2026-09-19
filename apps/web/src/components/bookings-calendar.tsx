"use client";

import { useMemo, useState } from "react";
import type { Booking, BookingStatus } from "./demo-data";
import { countLabel, dayKey, dayLabel, firstDayKey, groupByDay, monthCells, monthLabel, monthOf, sameMonth, shiftMonth, weekdayHeadings, type CalendarMonth } from "./bookings-calendar-state";
import { Icon } from "./icons";
import { Badge, EmptyState } from "./ui";

const tones: Record<BookingStatus, "success" | "warning" | "danger"> = { confirmed: "success", pending: "warning", canceled: "danger" };
const chipLimit = 3;

// The month grid beside the selected day's agenda. Month and day selection live here and start from
// `anchorDay`; the parent remounts the calendar (by key) when the anchor should win again -- first
// load, or a booking deep-linked from the dashboard -- so the barber's own navigation is never yanked
// away mid-look. Every date is a civil date in the studio timezone; the browser's zone plays no part.
// Canceled bookings never appear here: they only clutter a day the barber is planning around, and the
// list layout still shows them for the record.
export function BookingsCalendar({ bookings, timeZone, anchorDay, onOpen }: { bookings: Booking[]; timeZone: string; anchorDay: string; onOpen: (booking: Booking, trigger: HTMLButtonElement) => void }) {
  const [month, setMonth] = useState<CalendarMonth>(() => monthOf(anchorDay));
  const [selectedDay, setSelectedDay] = useState(anchorDay);
  const today = useMemo(() => dayKey(new Date(), timeZone), [timeZone]);
  const groups = useMemo(() => groupByDay(bookings.filter((booking) => booking.status !== "canceled"), timeZone), [bookings, timeZone]);
  const cells = useMemo(() => monthCells(month), [month]);
  const timeFormatter = useMemo(() => new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }), [timeZone]);
  const monthCount = cells.reduce((total, cell) => total + (cell ? groups.get(cell.key)?.length ?? 0 : 0), 0);
  const dayBookings = groups.get(selectedDay) ?? [];
  const label = monthLabel(month);
  // Moving months lands the agenda on today when it is in view, otherwise on the 1st, so what the
  // agenda shows is always a day of the month on screen.
  const showMonth = (next: CalendarMonth) => { setMonth(next); setSelectedDay(sameMonth(next, monthOf(today)) ? today : firstDayKey(next)); };

  return <section className="panel bookings-calendar" aria-label="Bookings calendar">
    <header className="calendar-nav"><div><h2>{label}</h2><span>{countLabel(monthCount)} this month</span></div><div className="calendar-nav-actions"><button type="button" className="button button-secondary button-sm" onClick={() => showMonth(monthOf(today))}>Today</button><button type="button" className="icon-button" onClick={() => showMonth(shiftMonth(month, -1))} aria-label="Previous month"><Icon name="arrow-left" /></button><button type="button" className="icon-button" onClick={() => showMonth(shiftMonth(month, 1))} aria-label="Next month"><Icon name="arrow-right" /></button></div></header>
    <div className="calendar-body">
      <div className="month-grid" role="group" aria-label={`${label} calendar`}>
        <div className="month-weekdays" aria-hidden="true">{weekdayHeadings.map((day) => <span key={day}>{day}</span>)}</div>
        <div className="month-days">{cells.map((cell, index) => {
          if (!cell) return <span key={`blank-${index}`} className="month-day is-blank" aria-hidden="true" />;
          const items = groups.get(cell.key) ?? [];
          const classes = ["month-day", cell.key === selectedDay ? "is-selected" : "", cell.key === today ? "is-today" : "", cell.key < today ? "is-past" : "", items.length ? "has-bookings" : ""].filter(Boolean).join(" ");
          return <button type="button" key={cell.key} className={classes} aria-pressed={cell.key === selectedDay} aria-label={`${dayLabel(cell.key)}, ${countLabel(items.length)}`} onClick={() => setSelectedDay(cell.key)}><span className="month-day-number">{cell.day}</span>{items.length > 0 && <span className="month-day-count">{items.length}</span>}<span className="month-day-chips">{items.slice(0, chipLimit).map((booking) => <span key={booking.id} className={`day-chip is-${booking.status}`}><i>{timeFormatter.format(new Date(booking.startsAt))}</i>{booking.invitee}</span>)}{items.length > chipLimit && <span className="day-chip-more">+{items.length - chipLimit} more</span>}</span></button>;
        })}</div>
      </div>
      <aside className="day-agenda" aria-label={`Bookings on ${dayLabel(selectedDay)}`}>
        <header><h3>{dayLabel(selectedDay)}</h3><span>{countLabel(dayBookings.length)}</span></header>
        {dayBookings.map((booking) => <button type="button" key={booking.id} className={`agenda-row is-${booking.status}`} onClick={(event) => onOpen(booking, event.currentTarget)} aria-haspopup="dialog"><span className="agenda-time"><strong>{booking.timeLabel}</strong><small>{booking.duration} min</small></span><span className="agenda-body"><strong>{booking.invitee}</strong><small>{booking.eventTitle}</small></span><Badge tone={tones[booking.status]} dot>{booking.status === "pending" ? "pending payment" : booking.status}</Badge></button>)}
        {dayBookings.length === 0 && <EmptyState icon="calendar" title="Nothing booked" description={selectedDay < today ? "No bookings were held on this day." : "This day is open."} />}
      </aside>
    </div>
  </section>;
}
