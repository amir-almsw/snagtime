import { requireWorkspaceMutationAccess } from "@/server/auth/session";
import { apiError, jsonBody, ok } from "@/server/http";
import { enforceRateLimit } from "@/server/rate-limit";
import { sendClientMessage } from "@/server/services/client-messaging";
import { clientMessageInput } from "@/server/validation";

// The Customers tab's bulk "Message selected" action. Admin-only, same-origin (requireWorkspaceMutationAccess
// asserts it), and rate-limited per workspace. Delivery is durable and spaced out: one EmailOutbox row per
// recipient, drained by the worker ~10s apart (see client-messaging.ts).
export async function POST(request: Request) {
  try {
    const access = await requireWorkspaceMutationAccess(request, "ADMIN");
    await enforceRateLimit(`bulk-message:workspace:${access.workspaceId}`, 20, 60 * 60_000);
    const input = clientMessageInput.parse(await jsonBody(request, 512 * 1024));
    return ok(await sendClientMessage(access.workspaceId, input), { status: 202 });
  } catch (error) { return apiError(error); }
}