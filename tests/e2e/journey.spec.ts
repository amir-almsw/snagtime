import { expect, test } from "@playwright/test";
import { assertNoClientSecretState, assertNoHorizontalOverflow, baseURL, createManagedBooking, createOrganizerAccount, db, latestAccountToken, latestBookingRecoveryToken, login, organizerEmail, organizerPassword, passClientGate, untracedJson } from "./helpers";

// This journey handles one-time authorities. Tracing is deliberately disabled so a
// failure artifact can never contain a request or response carrying an authority.
test.use({ trace: "off" });

async function waitForCalendarSync(bookingId: string) {
  const deadline = Date.now() + 5_000;
  do {
    const booking = await db.booking.findUnique({ where: { id: bookingId }, select: { calendarLeaseToken: true, calendarSyncStatus: true } });
    if (booking && booking.calendarLeaseToken === null && booking.calendarSyncStatus !== "PENDING") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error("The booking calendar update did not settle within the bounded wait.");
}

test("@journey verification, onboarding, scheduling, recovery and tenant isolation", async ({ page, context }, testInfo) => {
  const suffix = testInfo.project.name.replaceAll(/[^a-z0-9]/gi, "-").toLowerCase();
  const accountPassword = process.env.PLAYWRIGHT_ACCOUNT_PASSWORD!;
  const replacementPassword = process.env.PLAYWRIGHT_REPLACEMENT_PASSWORD!;
  const account = await createOrganizerAccount(`account-${suffix}`, accountPassword, { verified: false });

  await untracedJson("/api/auth/verify-email/request", { method: "POST", body: JSON.stringify({ email: account.email }) });
  const verification = await latestAccountToken(account.email, "EMAIL_VERIFY");
  await untracedJson("/api/auth/verify-email/consume", { method: "POST", body: JSON.stringify({ token: verification }) });
  await login(page, account.email, accountPassword);
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByRole("button", { name: "Open dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Studio overview" })).toBeVisible();

  await page.goto("/event-types/new");
  await page.getByLabel("Service name").fill(`Quality call ${suffix}`);
  await page.getByLabel("Booking link").fill(`quality-${suffix}`);
  await page.getByLabel("Location").selectOption({ label: "Phone call" });
  await page.getByLabel("Phone instructions").fill("Organizer calls the invitee at the number supplied during booking.");
  await page.getByRole("button", { name: "Publish service" }).click();
  await expect(page.getByRole("status")).toContainText("Changes saved");

  await page.goto("/forgot-password");
  await page.getByLabel("Email address").fill(account.email);
  await page.getByRole("button", { name: "Request reset instructions" }).click();
  await expect(page.getByRole("status")).toContainText("Request accepted");
  const reset = await latestAccountToken(account.email, "PASSWORD_RESET");
  await untracedJson("/api/auth/password-reset/consume", { method: "POST", body: JSON.stringify({ token: reset, newPassword: replacementPassword }) });
  await context.clearCookies();
  await login(page, account.email, replacementPassword);

  // Traverse the real public UI once per browser project. The later managed
  // booking exercises the API race/recovery surface with its returned cookie.
  await context.clearCookies();
  await passClientGate(context);
  await page.goto("/book/strategy-call");
  await expect(page.locator(".time-grid button").first()).toBeVisible();
  await page.locator(".time-grid button").first().click();
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByLabel("Name").fill(`Browser invitee ${suffix}`);
  await page.getByLabel("Email address").fill(`browser-${suffix}@example.com`);
  await page.getByRole("button", { name: "Review booking" }).click();
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("heading", { name: /You’re booked/ })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("booking")).toBeTruthy();

  await context.clearCookies();
  await login(page, organizerEmail, organizerPassword);
  const managed = await createManagedBooking(context, suffix);
  await page.goto(`/book/strategy-call/confirmation?booking=${encodeURIComponent(managed.id)}`);
  await expect(page.getByRole("heading", { name: /You’re booked/ })).toBeVisible();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const from = new Date(); const to = new Date(from.getTime() + 30 * 86_400_000);
    const slots = await fetch(`${baseURL}/api/bookings/${managed.id}/slots?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&timeZone=${encodeURIComponent("America/Chicago")}&durationId=${encodeURIComponent(managed.durationId)}`, { headers: { Cookie: managed.cookie } }).then((response) => response.json()) as { data: Array<{ start: string }> };
    const next = slots.data.find((slot) => slot.start !== managed.startAt); if (!next) throw new Error("No reschedule slot was available.");
    const rescheduled = await untracedJson(`/api/bookings/${managed.id}`, { method: "PATCH", headers: { Cookie: managed.cookie }, body: JSON.stringify({ startAt: next.start }) });
    expect((await rescheduled.json() as { data: { startAt: string } }).data.startAt).toBe(next.start); managed.startAt = next.start;
    await waitForCalendarSync(managed.id);
  }
  await untracedJson("/api/bookings/manage-link", { method: "POST", body: JSON.stringify({ bookingId: managed.id, email: `invitee-${suffix}@example.com` }) });
  await page.request.post("/api/integrations/email/inbox");
  expect(await latestBookingRecoveryToken(managed.id)).toMatch(/^v1\./);
  const cancelled = await untracedJson(`/api/bookings/${managed.id}`, { method: "DELETE", headers: { Cookie: managed.cookie }, body: JSON.stringify({ reason: "E2E cancellation" }) });
  expect((await cancelled.json() as { data: { status: string } }).data.status).toBe("CANCELLED");

  // Tenant isolation: the fresh workspace never sees the seeded workspace's event
  // types, and the registration and invitation surfaces no longer exist at all.
  const foreignEventCount = await db.eventType.count({ where: { workspaceId: account.workspaceId, slug: "strategy-call" } });
  expect(foreignEventCount).toBe(0);
  for (const [path, method] of [["/api/auth/register", "POST"], ["/api/workspace/invitations", "GET"], ["/api/workspace/members", "GET"], ["/api/workspace/switch", "POST"], ["/api/webhooks/stripe", "POST"]] as const) {
    const response = await fetch(`${baseURL}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
    expect(response.status, `${path} must be removed`).toBe(404);
  }

  await context.clearCookies(); await login(page, organizerEmail, organizerPassword);
  await page.goto("/integrations");
  await expect(page.getByRole("heading", { name: /Integrations/i })).toBeVisible();
  await expect(page.getByText(`invitee-${suffix}@example.com`).first()).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await assertNoClientSecretState(context, page);
});
