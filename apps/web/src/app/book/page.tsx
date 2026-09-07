import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/ui";
import { gateCookieName, readGateToken } from "@/server/auth/client-gate";
import { listPublicEventDirectory } from "@/server/services/event-types";
export const metadata = { title: "Book an appointment" };
export const dynamic = "force-dynamic";
export default async function BookingDirectoryPage() {
  // Redirect convenience only; the authoritative gate check lives in every /api/public handler.
  if (!readGateToken((await cookies()).get(gateCookieName())?.value)) redirect(`/gate?next=${encodeURIComponent("/book")}`);
  const events = await listPublicEventDirectory();
  const only = events.length === 1 ? events[0] : undefined;
  if (only) redirect(`/book/${only.slug}`);
  return (
    <div className="auth-page">
      <main className="auth-card">
        <BrandMark />
        <div><span className="outcome-eyebrow">Book an appointment</span><h1>What are we doing today?</h1><p>{events.length ? "Choose your service and we’ll show you what’s open." : "The book is closed right now. Check back soon, or get in touch with the studio."}</p></div>
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
      </main>
    </div>
  );
}
