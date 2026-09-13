import { assertSameOrigin, getSessionRecord } from "@/server/auth/session";
import { acknowledgeBookingManageSession, exchangeBookingCapabilities, lastBookingCookieName, lastBookingCookieOptions, manageCookieName, manageCookieOptions } from "@/server/auth/capabilities";
import { enterCapabilityDatabaseContext } from "@/server/db-context";
import { apiError, jsonBody, ok } from "@/server/http";
import { clientAddress, enforceRateLimit } from "@/server/rate-limit";
import { getBookingForHost } from "@/server/services/bookings";
import { bookingCapabilityExchangeInput } from "@/server/validation";

type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  try {
    assertSameOrigin(request); await enforceRateLimit(`manage-exchange:${clientAddress(request)}`, 12, 15 * 60_000);
    const { id } = await context.params; const bundle = bookingCapabilityExchangeInput.parse(await jsonBody(request));
    const session = await exchangeBookingCapabilities(id, bundle);
    const response = ok({ established: true as const });
    response.cookies.set(manageCookieName(id), session.token, { ...manageCookieOptions, expires: session.expiresAt });
    response.cookies.set(lastBookingCookieName(), id, lastBookingCookieOptions);
    response.headers.set("Cache-Control", "no-store"); response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request, context: Context) {
  try {
    assertSameOrigin(request); const { id } = await context.params;
    await enforceRateLimit(`manage-ack:${clientAddress(request)}`, 30, 15 * 60_000);
    // An organizer reaches /manage/* through the session cookie and never holds a booking manage
    // session, so there is nothing to acknowledge and no one-use capability to burn. Without this the
    // shared reschedule view's unconditional acknowledge threw notFound and the dashboard's own
    // Reschedule link answered "Booking was not found" -- cancel worked only because that view never
    // acknowledges. Entered before the first await so the store reaches this frame (see db-context.ts);
    // a valid organizer cookie replaces it synchronously inside getSessionRecord().
    enterCapabilityDatabaseContext(id);
    const organizer = await getSessionRecord(request);
    if (organizer) { await getBookingForHost(organizer.activeWorkspaceId, id); return ok({ acknowledged: true as const }); }
    return ok(await acknowledgeBookingManageSession(request, id));
  } catch (error) { return apiError(error); }
}
