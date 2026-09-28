// Hands a known client from the Customers tab to the Bookings page's "Add booking" form. Session storage
// rather than the URL, so a client's name and address never land in the proxy's access log or the
// browser history; the entry is read once and removed.
const KEY = "dvision:book-for-client";
export type BookForClient = { name: string; email: string };

export function stashClientForBooking(client: BookForClient) {
  try { window.sessionStorage.setItem(KEY, JSON.stringify(client)); } catch { /* the form then simply opens empty */ }
}

export function takeClientForBooking(): BookForClient | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(KEY);
    const parsed = JSON.parse(raw) as Partial<BookForClient>;
    return typeof parsed.name === "string" && typeof parsed.email === "string" ? { name: parsed.name, email: parsed.email } : null;
  } catch { return null; }
}
