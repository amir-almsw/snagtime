import { requireWorkspaceMutationAccess } from "@/server/auth/session";
import { apiError, ok } from "@/server/http";
import { clientAddress, enforceRateLimit } from "@/server/rate-limit";
import { ensureStudioQuickService } from "@/server/services/event-types";

// The hidden "Quick appointment" service the dashboard offers from the calendar's gap "+" buttons. This
// ensures it exists (idempotent) and returns its id and 15-minute duration so the form can book it.
export async function GET(request: Request) {
  try {
    await enforceRateLimit(`quick-service:ip:${clientAddress(request)}`, 120, 60_000);
    const access = await requireWorkspaceMutationAccess(request, "ADMIN");
    return ok(await ensureStudioQuickService(access.workspaceId, access.user.id));
  } catch (error) { return apiError(error); }
}
