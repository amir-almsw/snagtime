import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PublicBookingFlow } from "@/components/public-booking-flow";
import { gateCookieName, readGateToken } from "@/server/auth/client-gate";
export const metadata = { title: "Book a time with SnagTime" };
export default async function PublicBookingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Redirect convenience only; the authoritative gate check lives in every /api/public handler.
  if (!readGateToken((await cookies()).get(gateCookieName())?.value)) redirect(`/gate?next=${encodeURIComponent(`/book/${slug}`)}`);
  return <PublicBookingFlow slug={slug} />;
}
