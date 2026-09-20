import { apiError, jsonBody, ok } from "@/server/http";
import { ACTIVE_BOOKING_EXISTS, createBooking } from "@/server/services/bookings";
import { bookingInput } from "@/server/validation";
import { AppError } from "@/server/errors";
import { clientAddress, enforceRateLimit } from "@/server/rate-limit";
import { exchangeBookingCapabilities, lastBookingCookieName, lastBookingCookieOptions, manageCookieName, manageCookieOptions, requireBookingManageSession } from "@/server/auth/capabilities";
import { requireClientGate } from "@/server/auth/client-gate";

type Context = { params: Promise<{ slug: string }> };
export async function POST(request: Request, context: Context) {
  try {
    requireClientGate(request);
    const { slug } = await context.params;
    // The untrusted local-demo bucket is intentionally fixed and bounded, but large enough for a room of demo users.
    await enforceRateLimit(`public-booking:${clientAddress(request)}`, 120, 60_000);
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) throw new AppError("INVALID_IDEMPOTENCY_KEY", "A valid Idempotency-Key header is required.", 400);
    const created = await createBooking(slug, bookingInput.parse(await jsonBody(request)), idempotencyKey);
    let session: Awaited<ReturnType<typeof exchangeBookingCapabilities>> | null = null;
    if (created.manageCapabilities) session = await exchangeBookingCapabilities(created.booking.id, created.manageCapabilities);
    const response = ok({
      bookingId: created.booking.id, status: created.booking.status, checkoutUrl: created.checkoutUrl, checkoutState: created.checkoutState,
      manageSessionEstablished: Boolean(session), manageCapabilities: null,
    }, { status: 201 });
    if (session) { response.cookies.set(manageCookieName(created.booking.id), session.token, { ...manageCookieOptions, expires: session.expiresAt }); response.cookies.set(lastBookingCookieName(), created.booking.id, lastBookingCookieOptions); }
    response.headers.set("Cache-Control", "no-store"); response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch (error) {
    // The blocking booking's id is only echoed back to a browser that already holds that booking's
    // manage session, so the rule cannot be used to probe which emails have an appointment.
    if (error instanceof AppError && error.code === ACTIVE_BOOKING_EXISTS) {
      const blocked = (error as AppError & { bookingId?: string }).bookingId;
      const owned = blocked ? await requireBookingManageSession(request, blocked, "read").then(() => true).catch(() => false) : false;
      const response = apiError(error);
      return owned ? Response.json({ error: { code: error.code, message: error.message, bookingId: blocked } }, { status: error.status, headers: { "Cache-Control": "no-store" } }) : response;
    }
    return apiError(error);
  }
}
