import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/ui";
import { UpcomingAppointmentCard } from "@/components/upcoming-appointment-card";
import { lastBookingCookieName } from "@/server/auth/capabilities";
import { gateCookieName, readGateToken } from "@/server/auth/client-gate";
import { listPublicEventDirectory } from "@/server/services/event-types";
export const metadata = { title: "Book an appointment" };
export const dynamic = "force-dynamic";
export default async function BookingDirectoryPage() {
  // Redirect convenience only; the authoritative gate check lives in every /api/public handler.
  if (!readGateToken((await cookies()).get(gateCookieName())?.value)) redirect(`/gate?next=${encodeURIComponent("/book")}`);
  const events = await listPublicEventDirectory();
  // Which booking this browser last managed, if any. The card below verifies it against the manage
  // session before showing anything, so a stale value renders nothing rather than a broken panel.
  const lastBooking = (await cookies()).get(lastBookingCookieName())?.value ?? "";
  const only = events.length === 1 ? events[0] : undefined;
  // A single-service studio normally goes straight to its one booking page. Someone who already has an
  // appointment is more likely here to change it than to book again, so they get the directory -- which
  // is where the card lives -- with that one service still one click away.
  if (only && !lastBooking) redirect(`/book/${only.slug}`);
  return (
    <div className="auth-page dvision">
      <main className="auth-card">
        <BrandMark />
        <div><span className="outcome-eyebrow">Book an appointment</span><h1>What are we doing today?</h1><p>{events.length ? "Choose your service and we’ll show you what’s open." : "The book is closed right now. Check back soon, or get in touch with the studio."}</p></div>
        {lastBooking && <UpcomingAppointmentCard bookingId={lastBooking} />}
        {events.length > 0 && (
          <ul className="directory-list">
            {events.map((event) => (
              <li key={event.slug}>
                <Link className="button button-secondary" href={`/book/${event.slug}`}>
                  <span>{event.name}</span><span className="directory-meta">{event.durationMinutes} min</span>
                </Link>
                {event.description && <p className="directory-description">{event.description}</p>}
              </li>
            ))}
          </ul>
        )}
        {/* The only route back to an existing appointment for someone on a new device or past their
            30-day manage cookie. A single-service studio redirects straight past this page, which is why
            the same link also sits in the booking flow's own header. */}
        <p className="manage-lookup-foot"><Link href="/manage">Already booked? Manage your appointment</Link></p>
      </main>
    </div>
  );
}
