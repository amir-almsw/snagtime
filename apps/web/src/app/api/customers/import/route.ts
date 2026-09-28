import { requireWorkspaceMutationAccess } from "@/server/auth/session";
import { apiError, jsonBody, ok } from "@/server/http";
import { importKnownClients } from "@/server/services/customers";
import { knownClientImportInput } from "@/server/validation";

// The browser reads the spreadsheet and posts plain rows, so the server never unpacks an uploaded archive.
// A 5000-row list of names, addresses and phone numbers stays well under this bound.
const IMPORT_BODY_MAX_BYTES = 1024 * 1024;
export async function POST(request: Request) {
  try { const access = await requireWorkspaceMutationAccess(request, "ADMIN"); return ok(await importKnownClients(access.workspaceId, knownClientImportInput.parse(await jsonBody(request, IMPORT_BODY_MAX_BYTES)).clients)); } catch (error) { return apiError(error); }
}
