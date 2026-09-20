import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PublicBookingFlow } from "@/components/public-booking-flow";
import { gateCookieName, readGateToken } from "@/server/auth/client-gate";
import { listPublicEventDirectory } from "@/server/services/event-types";
export const metadata = { title: "Book an appointment" };
export default async function PublicBookingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Redirect convenience only; the authoritative gate check lives in every /api/public handler.
  if (!readGateToken((await cookies()).get(gateCookieName())?.value)) redirect(`/gate?next=${encodeURIComponent(`/book/${slug}`)}`);
  // With a single active service /book redirects straight back here, so the way back to the service list
  // is offered only when there is actually a choice to make.
  const services = await listPublicEventDirectory().catch(() => []);
  return <PublicBookingFlow slug={slug} showServiceSwitch={services.length > 1} />;
}
