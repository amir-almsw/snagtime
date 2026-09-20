import { NextResponse, type NextRequest } from "next/server";
import { requestId } from "@/server/observability";
import { surfaceAllows } from "@/server/surface";

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  // 404, never 403: a scanner probing the booking host must not learn that an admin surface exists.
  if (!surfaceAllows(process.env.SURFACE, pathname)) return new NextResponse(null, { status: 404 });
  if (!pathname.startsWith("/api/")) return NextResponse.next();
  const id = requestId(request.headers.get("x-request-id")); const headers = new Headers(request.headers); headers.set("x-request-id", id);
  const response = NextResponse.next({ request: { headers } }); response.headers.set("x-request-id", id); return response;
}
export const config = { matcher: ["/((?!_next|favicon\\.ico|manifest\\.webmanifest).*)"] };
