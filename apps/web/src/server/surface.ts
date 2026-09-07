// Host-scoped route enforcement for the split booking/admin origins (one image, two containers).
// SURFACE comes from per-service environment, never the spoofable Host header. Unset means the
// single-origin dev/demo/test topology, where every route stays reachable.
export type Surface = "book" | "admin";

// /manage/* and /api/bookings/* are deliberately on BOTH surfaces: the dashboard's organizer
// override controls link relatively to /manage/{id}/… (resolving against the admin origin), and
// each of those routes authorizes independently via session or signed capability.
const bookPrefixes = ["/gate", "/book", "/manage", "/api/gate", "/api/public", "/api/bookings", "/api/health"];
const adminPrefixes = [
  "/dashboard", "/bookings", "/availability", "/event-types", "/integrations", "/settings", "/onboarding",
  "/forgot-password", "/reset-password", "/verify-email", "/manage",
  "/api/auth", "/api/account", "/api/workspace", "/api/event-types", "/api/availability", "/api/settings", "/api/integrations", "/api/bookings", "/api/health",
];

function matchesPrefix(pathname: string, prefixes: string[]) { return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)); }

export function surfaceAllows(surface: string | undefined, pathname: string) {
  if (surface !== "book" && surface !== "admin") return true;
  if (pathname === "/") return true;
  return matchesPrefix(pathname, surface === "book" ? bookPrefixes : adminPrefixes);
}
