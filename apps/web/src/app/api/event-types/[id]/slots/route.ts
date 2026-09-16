import { DateTime, IANAZone } from "luxon";
import { requireWorkspaceAccess } from "@/server/auth/session";
import { AppError } from "@/server/errors";
import { apiError, ok } from "@/server/http";
import { clientAddress, enforceRateLimit } from "@/server/rate-limit";
import { listPublicSlots } from "@/server/services/bookings";
import { getEventTypeById } from "@/server/services/event-types";

type Context = { params: Promise<{ id: string }> };

// Open times for the dashboard's own booking form. The organizer is offered exactly what a client
// would be offered -- listPublicSlots, the same schedule, buffers, notice and booked time -- because
// createBooking validates the chosen start against that same list before it writes anything.
export async function GET(request: Request, context: Context) {
  try {
    await enforceRateLimit(`host-slots:ip:${clientAddress(request)}`, 240, 60_000);
    const access = await requireWorkspaceAccess(request);
    await enforceRateLimit(`host-slots:workspace:${access.workspaceId}`, 240, 60_000);
    const { id } = await context.params;
    const eventType = await getEventTypeById(access.workspaceId, id);
    const url = new URL(request.url); const timeZone = url.searchParams.get("timeZone") || "UTC";
    if (!IANAZone.isValidZone(timeZone)) throw new AppError("INVALID_TIME_ZONE", "Choose a valid IANA time zone.", 400);
    const from = DateTime.fromISO(url.searchParams.get("from") || "", { zone: "utc" });
    const to = DateTime.fromISO(url.searchParams.get("to") || "", { zone: "utc" });
    if (!from.isValid || !to.isValid || to <= from || to.diff(from, "days").days > 31) throw new AppError("INVALID_SLOT_RANGE", "Choose a valid slot range of no more than 31 days.", 400);
    return ok(await listPublicSlots(eventType.slug, from.toJSDate(), to.toJSDate(), timeZone, undefined, url.searchParams.get("durationId") || undefined));
  } catch (error) { return apiError(error); }
}
