import { redirect } from "next/navigation";
import { CancelBookingView } from "@/components/booking-outcome";
export const metadata = { title: "Cancel booking" };
export default async function CancelPage({ params, searchParams }: { params: Promise<{ bookingId: string }>; searchParams: Promise<{ slug?: string; recovery?: string; read?: string; capability?: string }> }) {
  const [{ bookingId }, query] = await Promise.all([params, searchParams]);
  // Nothing this app sends puts ?recovery= on the cancel path -- emails link to /reschedule -- but a
  // hand-edited or forwarded link would leave a live recovery token in the query string, where the
  // reverse proxy logs it. Move it to the fragment exactly as the reschedule page does, so the token
  // never leaves the browser. The cancel view claims no fragment authority, so nothing reads it here.
  if (query.recovery) redirect(`/manage/${encodeURIComponent(bookingId)}/cancel${query.slug ? `?slug=${encodeURIComponent(query.slug)}` : ""}#recovery=${encodeURIComponent(query.recovery)}`);
  if (query.read || query.capability) redirect(`/manage/${encodeURIComponent(bookingId)}/cancel${query.slug ? `?slug=${encodeURIComponent(query.slug)}` : ""}`);
  return <CancelBookingView bookingId={bookingId} slug={query.slug} />;
}
