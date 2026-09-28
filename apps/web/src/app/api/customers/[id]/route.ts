import { requireWorkspaceMutationAccess } from "@/server/auth/session";
import { apiError, ok } from "@/server/http";
import { deleteKnownClient } from "@/server/services/customers";

type Context = { params: Promise<{ id: string }> };
export async function DELETE(request: Request, context: Context) {
  try { const access = await requireWorkspaceMutationAccess(request, "ADMIN"); const { id } = await context.params; return ok(await deleteKnownClient(access.workspaceId, id)); } catch (error) { return apiError(error); }
}
