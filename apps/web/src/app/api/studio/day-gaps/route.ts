import { requireWorkspaceAccess } from "@/server/auth/session";
import { AppError } from "@/server/errors";
import { apiError, ok } from "@/server/http";
import { clientAddress, enforceRateLimit } from "@/server/rate-limit";
import { listDayGaps } from "@/server/services/bookings";

// The free stretches of a civil date, for the bookings calendar's gap "+" buttons. Times come back as
// UTC instants; the dashboard renders them in the studio zone.
export async function GET(request: Request) {
  try {
    await enforceRateLimit(`day-gaps:ip:${clientAddress(request)}`, 120, 60_000);
    const access = await requireWorkspaceAccess(request);
    const date = new URL(request.url).searchParams.get("date") || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError("INVALID_DATE", "Choose a valid date.", 400);
    return ok(await listDayGaps(access.workspaceId, access.user.id, date));
  } catch (error) { return apiError(error); }
}
