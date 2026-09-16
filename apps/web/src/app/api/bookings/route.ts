import { requireWorkspaceAccess, requireWorkspaceMutationAccess } from "@/server/auth/session";
import { AppError } from "@/server/errors";
import { apiError, jsonBody, ok } from "@/server/http";
import { clientAddress, enforceRateLimit } from "@/server/rate-limit";
import { createBooking, listBookings } from "@/server/services/bookings";
import { getEventTypeById } from "@/server/services/event-types";
import { hostBookingInput } from "@/server/validation";

export async function GET(request: Request) {
  try { const access = await requireWorkspaceAccess(request); return ok(await listBookings(access.workspaceId)); } catch (error) { return apiError(error); }
}

// The studio books a client in from the dashboard. createBooking is reused exactly as the public page
// calls it -- same slot check, same outbox rows, same public booking database context -- so the
// appointment is indistinguishable from one the client made and needs no policy of its own. The event
// type is resolved inside the caller's workspace first: slugs are globally unique, so handing an
// unchecked one to createBooking would let an organizer book into another studio's calendar.
export async function POST(request: Request) {
  try {
    await enforceRateLimit(`host-booking:ip:${clientAddress(request)}`, 60, 60_000);
    const access = await requireWorkspaceMutationAccess(request, "ADMIN");
    await enforceRateLimit(`host-booking:workspace:${access.workspaceId}`, 60, 60_000);
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) throw new AppError("INVALID_IDEMPOTENCY_KEY", "A valid Idempotency-Key header is required.", 400);
    const { eventTypeId, ...input } = hostBookingInput.parse(await jsonBody(request));
    const eventType = await getEventTypeById(access.workspaceId, eventTypeId);
    const created = await createBooking(eventType.slug, input, idempotencyKey, undefined, undefined, { allowSecondActiveBooking: true });
    return ok(created.booking, { status: 201 });
  } catch (error) { return apiError(error); }
}
