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

// /api/bookings/* stays on the booking surface for the manage flow above, but the collection route
// itself is the organizer's whole-workspace list, invitee names and emails included, and belongs to
// the dashboard alone. A prefix cannot express "children but not the collection", so the exact path
// is denied ahead of the prefix match. The organizer cookie is host-scoped and never reaches the
// booking origin, so this is defence in depth rather than the check that was holding the line.
const bookDeniedPaths = ["/api/bookings"];

function matchesPrefix(pathname: string, prefixes: string[]) { return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)); }

export function surfaceAllows(surface: string | undefined, pathname: string) {
  if (surface !== "book" && surface !== "admin") return true;
  if (pathname === "/") return true;
  if (surface === "book" && bookDeniedPaths.includes(pathname)) return false;
  return matchesPrefix(pathname, surface === "book" ? bookPrefixes : adminPrefixes);
}
