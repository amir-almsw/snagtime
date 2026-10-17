import { requireWorkspaceMutationAccess } from "@/server/auth/session";
import { AppError } from "@/server/errors";
import { apiError, jsonBody, ok } from "@/server/http";
import { clientAddress, enforceRateLimit } from "@/server/rate-limit";
import { createBooking } from "@/server/services/bookings";
import { ensureStudioQuickService, QUICK_SLOT_SLUG } from "@/server/services/event-types";
import { quickBookingInput } from "@/server/validation";

// Books a client into the hidden 15-minute "Quick appointment" service from a calendar gap. Reuses
// createBooking exactly like the regular dashboard booking, so the appointment is indistinguishable from
// one the client made; allowInternalService is the only gate the public page never receives.
export async function POST(request: Request) {
  try {
    await enforceRateLimit(`quick-booking:ip:${clientAddress(request)}`, 30, 60_000);
    const access = await requireWorkspaceMutationAccess(request, "ADMIN");
    await enforceRateLimit(`quick-booking:workspace:${access.workspaceId}`, 30, 60_000);
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) throw new AppError("INVALID_IDEMPOTENCY_KEY", "A valid Idempotency-Key header is required.", 400);
    await ensureStudioQuickService(access.workspaceId, access.user.id);
    const input = quickBookingInput.parse(await jsonBody(request));
    const created = await createBooking(QUICK_SLOT_SLUG, input, idempotencyKey, undefined, undefined, { allowInternalService: true, allowSecondActiveBooking: true, byStudio: true });
    return ok(created.booking, { status: 201 });
  } catch (error) { return apiError(error); }
}
