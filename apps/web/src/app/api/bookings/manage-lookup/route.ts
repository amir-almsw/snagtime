import { assertSameOrigin } from "@/server/auth/session";
import { apiError, jsonBody, ok } from "@/server/http";
import { clientAddress, enforceRateLimit } from "@/server/rate-limit";
import { requestBookingManageLinkByLookup } from "@/server/services/booking-recovery";
import { bookingManageLookupInput } from "@/server/validation";

// Deliberately reuses the (20, 1h) and (5, 1h) pairs already registered for /api/bookings/manage-link:
// tempocove_rate_limit() is an allowlist, so an unregistered pair would answer 429 to everyone for ever.
// Adding a pair here means adding it to tempocove_rate_policy in postgres-guards.sql as well.
export async function POST(request: Request) {
  try {
    // Not behind the client gate, matching /api/bookings/manage-link: this is the path for someone who
    // lost their link, and a lapsed gate cookie is precisely the situation it has to survive. It reveals
    // nothing and is rate limited per address and per caller, so leaving it open costs nothing.
    assertSameOrigin(request);
    const input = bookingManageLookupInput.parse(await jsonBody(request));
    await enforceRateLimit(`booking-recovery:ip:${clientAddress(request)}`, 20, 60 * 60_000);
    // Buckets on what was asked about rather than who asked, so one address or code cannot be hammered
    // from many sources. Both are already lower-cased and bounded by the schema above.
    await enforceRateLimit(`booking-recovery:resource:lookup:${(input.reference || input.email || "").toLowerCase()}`, 5, 60 * 60_000);
    // Always 202 with the same body. Whether anything matched is never revealed here or by timing.
    return ok(await requestBookingManageLinkByLookup(input), { status: 202 });
  } catch (error) { return apiError(error); }
}
