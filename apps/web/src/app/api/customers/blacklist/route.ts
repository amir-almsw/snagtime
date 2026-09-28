import { requireWorkspaceAccess, requireWorkspaceMutationAccess } from "@/server/auth/session";
import { apiError, jsonBody, ok } from "@/server/http";
import { blockEmail, listBlockedEmails } from "@/server/services/customers";
import { blockedEmailInput } from "@/server/validation";

// Blacklisting an address also cancels its upcoming appointments (see blockEmail).
export async function GET(request: Request) {
  try { const access = await requireWorkspaceAccess(request); return ok(await listBlockedEmails(access.workspaceId)); } catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try { const access = await requireWorkspaceMutationAccess(request, "ADMIN"); return ok(await blockEmail(access.workspaceId, blockedEmailInput.parse(await jsonBody(request))), { status: 201 }); } catch (error) { return apiError(error); }
}
