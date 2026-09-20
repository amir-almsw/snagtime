import { redirect } from "next/navigation";
import { CancelBookingView } from "@/components/booking-outcome";
import { BackTargetProvider } from "@/components/back-target";
// SURFACE is per-container environment, never the spoofable Host header (see server/surface.ts). The
// studio reaches these pages from its dashboard and has no sidebar here; a client arrives from an
// emailed link and belongs back at the booking list.
const backTarget = process.env.SURFACE === "admin" ? { href: "/dashboard", label: "Dashboard" } : { href: "/book", label: "Book" };
export const metadata = { title: "Cancel booking" };
export default async function CancelPage({ params, searchParams }: { params: Promise<{ bookingId: string }>; searchParams: Promise<{ slug?: string; recovery?: string; read?: string; capability?: string }> }) {
  const [{ bookingId }, query] = await Promise.all([params, searchParams]);
  // Nothing this app sends puts ?recovery= on the cancel path -- emails link to /reschedule -- but a
  // hand-edited or forwarded link would leave a live recovery token in the query string, where the
  // reverse proxy logs it. Move it to the fragment exactly as the reschedule page does, so the token
  // never leaves the browser. The cancel view claims no fragment authority, so nothing reads it here.
  if (query.recovery) redirect(`/manage/${encodeURIComponent(bookingId)}/cancel${query.slug ? `?slug=${encodeURIComponent(query.slug)}` : ""}#recovery=${encodeURIComponent(query.recovery)}`);
  if (query.read || query.capability) redirect(`/manage/${encodeURIComponent(bookingId)}/cancel${query.slug ? `?slug=${encodeURIComponent(query.slug)}` : ""}`);
  return <BackTargetProvider value={backTarget}><CancelBookingView bookingId={bookingId} slug={query.slug} /></BackTargetProvider>;
}
