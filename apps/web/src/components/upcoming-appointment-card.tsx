"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { BookingSummary } from "@/lib/contracts";
import { frontendApi } from "./api-adapter";
import { Icon } from "./icons";

// Shown above the service list when this browser still holds a manage session. Deliberately a card and
// not a redirect: a barbershop's customers come back to book again, and sending them straight into an
// existing appointment would strand a repeat customer and, on a shared device, show one person another
// person's details. Nothing is revealed that the manage session did not already authorise.
export function UpcomingAppointmentCard({ bookingId }: { bookingId: string }) {
  const [booking, setBooking] = useState<BookingSummary | null>(null);

  useEffect(() => {
    let active = true;
    // A stale or expired cookie simply renders nothing -- no error, no empty frame. The manage page
    // itself is what offers recovery when someone follows a link whose session has lapsed.
    frontendApi.getBookingForManage(bookingId)
      .then((item) => { if (active && item.status === "CONFIRMED" && new Date(item.endAt).getTime() > Date.now()) setBooking(item); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [bookingId]);

  if (!booking) return null;
  const start = new Date(booking.startAt);
  const when = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: booking.inviteeTimeZone }).format(start);
  return (
    <section className="current-booking" aria-label="Your upcoming appointment">
      <div className="current-booking-head">
        <span className="outcome-eyebrow">Your appointment</span>
        {booking.reference && <code className="current-booking-reference">{booking.reference}</code>}
      </div>
      <strong>{booking.eventTitleSnapshot}</strong>
      <span><Icon name="clock" size={14} />{when}</span>
      <div className="current-booking-actions">
        <Link className="button button-secondary" href={`/manage/${encodeURIComponent(booking.id)}/reschedule`}>Reschedule</Link>
        <Link className="button button-secondary" href={`/manage/${encodeURIComponent(booking.id)}/cancel`}>Cancel</Link>
      </div>
    </section>
  );
}
