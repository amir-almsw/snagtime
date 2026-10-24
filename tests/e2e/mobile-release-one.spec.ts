import { expect, test, type Page } from "@playwright/test";
import { assertNoHorizontalOverflow, createManagedBooking, login } from "./helpers";

test.use({ viewport: { width: 390, height: 844 } });

const clients = [
  { id: "known-amir", name: "Amir El Idrissi", email: "amir.elidrissi@example.nl", phone: "+31 6 12345678", createdAt: "2026-10-01T10:00:00.000Z", blocked: false },
  { id: "known-sanne", name: "Sanne de Vries", email: "sanne.devries@example.nl", phone: null, createdAt: "2026-10-02T10:00:00.000Z", blocked: false },
];

async function stubCustomers(page: Page) {
  await page.route("**/api/customers**", (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.continue();
    const path = new URL(request.url()).pathname;
    if (path === "/api/customers") return route.fulfill({ json: { data: clients } });
    if (path === "/api/customers/blacklist") return route.fulfill({ json: { data: [] } });
    return route.continue();
  });
}

test("the dashboard leads with today and opens the booking form in one tap", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Phone layout only");
  await login(page);
  const startAt = new Date();
  const endAt = new Date(startAt.getTime() + 30 * 60_000);
  const todayBooking = {
    id: "dashboard-today", reference: null, eventTypeId: "strategy-call", eventTypeName: "Strategy Call",
    inviteeName: "Today Client", inviteeEmail: "today@example.com", eventTitleSnapshot: "Strategy Call",
    locationType: "IN_PERSON" as const, locationValue: "Dvision Studio", calendarProvider: "local" as const,
    inviteeTimeZone: "Europe/Amsterdam", startAt: startAt.toISOString(), endAt: endAt.toISOString(),
    status: "CONFIRMED" as const, notes: null, calendarSyncStatus: "LOCAL" as const,
    notificationStatus: "LOCAL_NO_EMAIL" as const, cancellationReason: null, hostName: "Dvision Studio",
    durationId: null, durationMinutes: 30, priceCents: 0, currency: "eur", bookingWindowDays: 60,
    refundStatus: "NOT_REQUIRED" as const, refundedAmountCents: 0, answers: [],
  };
  await page.route("**/api/bookings", (route) => route.request().method() === "GET" ? route.fulfill({ json: { data: [todayBooking] } }) : route.continue());
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Studio overview" })).toBeVisible();
  await expect(page.getByText("Today Client")).toBeVisible();
  await expect(page.locator(".today-row")).toHaveCount(1);
  await expect(page.locator(".time-chip")).not.toContainText("–");

  await page.locator(".page-header").getByRole("link", { name: "Add booking" }).click();
  await expect(page).toHaveURL(/\/bookings$/);
  await expect(page.locator(".detail-drawer").getByRole("heading", { name: "Add booking" })).toBeVisible();
  await page.locator(".detail-drawer").getByRole("button", { name: "Close the new booking form" }).click();
  await assertNoHorizontalOverflow(page);
});

test("customers expose phone, email and a one-recipient message composer", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Phone layout only");
  await login(page);
  await stubCustomers(page);
  await page.goto("/customers");
  await expect(page.getByRole("heading", { name: "Customers" })).toBeVisible();

  await expect(page.getByRole("link", { name: "amir.elidrissi@example.nl" })).toHaveAttribute("href", "mailto:amir.elidrissi@example.nl");
  await expect(page.getByRole("link", { name: "+31 6 12345678" })).toHaveAttribute("href", "tel:+31612345678");

  await page.getByRole("button", { name: "Message Amir El Idrissi" }).click();
  await expect(page.getByRole("heading", { name: "Message customers" })).toBeVisible();
  await expect(page.getByText("Sending to 1 customer")).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Message customers" })).toHaveCount(0);
  await assertNoHorizontalOverflow(page);
});

test("a booking can be canceled from its drawer and exposes the contact actions", async ({ page, context }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Phone layout only");
  const booking = await createManagedBooking(context, `mobile-cancel-${testInfo.project.name}-${Date.now()}`);
  await login(page);
  await page.goto(`/bookings?selected=${booking.id}`);
  const drawer = page.locator(".detail-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await expect(drawer.getByRole("link", { name: "Reschedule" })).toHaveAttribute("href", /\/manage\/.+\/reschedule/);
  await expect(drawer.getByRole("link", { name: "Email" })).toHaveAttribute("href", /^mailto:/);

  await drawer.getByRole("button", { name: "Cancel", exact: true }).click();
  await drawer.getByLabel("Reason (optional)").fill("Client called to cancel");
  await drawer.getByRole("button", { name: "Cancel booking" }).click();
  await expect(page.getByText("Booking canceled. The client was emailed.")).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Cancel booking" })).toHaveCount(0);
  await expect(drawer.getByText("canceled")).toBeVisible();
  await assertNoHorizontalOverflow(page);
});


test("availability saves from the sticky bar and warns before leaving unsaved edits", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Phone layout only");
  await login(page);
  await page.goto("/availability");
  await expect(page.getByRole("heading", { name: "Availability" })).toBeVisible();

  const saturday = page.getByRole("switch", { name: "Saturday availability" });
  await saturday.click();
  const bar = page.locator(".availability-save-bar");
  await expect(bar).toBeVisible();
  await expect(bar.locator(".availability-save-state")).toHaveText("Unsaved changes");

  await page.getByRole("button", { name: "Open navigation" }).click();
  page.once("dialog", async (dialog) => { expect(dialog.message()).toContain("unsaved availability"); await dialog.dismiss(); });
  await page.getByRole("link", { name: "Customers" }).click();
  await expect(page).toHaveURL(/\/availability$/);
  await page.locator(".sidebar-close").click();

  await saturday.click();
  await bar.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Availability saved")).toBeVisible();
  await expect(bar.locator(".availability-save-state")).toHaveText("All changes saved");
  await assertNoHorizontalOverflow(page);
});

test("services explain an empty search and what is left before publishing", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Phone layout only");
  await login(page);
  await page.goto("/event-types");
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();
  await page.getByRole("textbox", { name: "Search services" }).fill("nothing-matches-this");
  await expect(page.getByText("No services match")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByRole("textbox", { name: "Search services" })).toHaveValue("");

  await page.goto("/event-types/new");
  await expect(page.locator(".editor-readiness")).toBeVisible();
  await expect(page.locator(".editor-readiness")).toContainText("To publish");
  await assertNoHorizontalOverflow(page);
});


test("the list view leads with today, then upcoming, then past", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Phone layout only");
  await login(page);
  const now = new Date();
  const summary = (id: string, name: string, start: Date) => ({
    id, reference: null, eventTypeId: "strategy-call", eventTypeName: "Strategy Call", inviteeName: name,
    inviteeEmail: `${id}@example.com`, eventTitleSnapshot: "Strategy Call", locationType: "IN_PERSON" as const,
    locationValue: "Dvision Studio", calendarProvider: "local" as const, inviteeTimeZone: "Europe/Amsterdam",
    startAt: start.toISOString(), endAt: new Date(start.getTime() + 30 * 60_000).toISOString(), status: "CONFIRMED" as const,
    notes: null, calendarSyncStatus: "LOCAL" as const, notificationStatus: "LOCAL_NO_EMAIL" as const, cancellationReason: null,
    hostName: "Dvision Studio", durationId: null, durationMinutes: 30, priceCents: 0, currency: "eur", bookingWindowDays: 60,
    refundStatus: "NOT_REQUIRED" as const, refundedAmountCents: 0, answers: [],
  });
  const past = summary("past", "Past Person", new Date(now.getTime() - 7 * 86_400_000));
  const future = summary("future", "Tomorrow Person", new Date(now.getTime() + 86_400_000));
  const today = summary("today", "Today Person", now);
  await page.route("**/api/bookings", (route) => route.request().method() === "GET" ? route.fulfill({ json: { data: [past, future, today] } }) : route.continue());
  await page.goto("/bookings");
  await page.getByRole("button", { name: "List", exact: true }).click();
  const rows = page.locator(".booking-table-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Today Person");
  await expect(rows.nth(1)).toContainText("Tomorrow Person");
  await expect(rows.nth(2)).toContainText("Past Person");
  await assertNoHorizontalOverflow(page);
});
