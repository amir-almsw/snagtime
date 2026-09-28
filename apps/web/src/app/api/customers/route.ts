import { requireWorkspaceAccess, requireWorkspaceMutationAccess } from "@/server/auth/session";
import { apiError, jsonBody, ok } from "@/server/http";
import { addKnownClient, listKnownClients } from "@/server/services/customers";
import { knownClientInput } from "@/server/validation";

// The studio's known clients. Admin-only surface (server/surface.ts); writes need an owner or admin.
export async function GET(request: Request) {
  try { const access = await requireWorkspaceAccess(request); return ok(await listKnownClients(access.workspaceId)); } catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try { const access = await requireWorkspaceMutationAccess(request, "ADMIN"); return ok(await addKnownClient(access.workspaceId, knownClientInput.parse(await jsonBody(request))), { status: 201 }); } catch (error) { return apiError(error); }
}
