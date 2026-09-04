import { expect, test } from "@playwright/test";
import { assertNoHorizontalOverflow, baseURL } from "./helpers";

test.use({ trace: "off" });

test("@gate unauthenticated public surfaces refuse to serve until the shop password is entered", async ({ page }, testInfo) => {
  const suffix = testInfo.project.name.replaceAll(/[^a-z0-9]/gi, "-").toLowerCase();

  // The authoritative check: public APIs answer 401 without a gate cookie, never slot data.
  const from = new Date(); const to = new Date(from.getTime() + 7 * 86_400_000);
  const slots = await fetch(`${baseURL}/api/public/strategy-call/slots?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&timeZone=${encodeURIComponent("America/Chicago")}`);
  expect(slots.status).toBe(401);
  expect(((await slots.json()) as { error: { code: string } }).error.code).toBe("CLIENT_GATE_REQUIRED");
  const event = await fetch(`${baseURL}/api/public/strategy-call`);
  expect(event.status).toBe(401);
  const booking = await fetch(`${baseURL}/api/public/strategy-call/bookings`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `e2e-gate-${suffix}-0000` }, body: "{}" });
  expect(booking.status).toBe(401);

  // The redirect convenience: the booking page bounces to the gate with a way back.
  const document = await fetch(`${baseURL}/book/strategy-call`, { redirect: "manual" });
  expect(document.status).toBe(307);
  expect(document.headers.get("location")).toContain("/gate?next=");

  await page.goto("/book/strategy-call");
  await expect(page).toHaveURL(/\/gate\?next=/);

  // A wrong password gets the one generic error and no entry.
  await page.getByLabel("Shop password").fill("not-the-shop-password");
  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.locator(".form-error")).toContainText("not correct");
  await expect(page).toHaveURL(/\/gate\?next=/);

  // The correct password completes the full gate → book → confirm journey.
  await page.getByLabel("Shop password").fill(process.env.PLAYWRIGHT_CLIENT_GATE_PASSWORD!);
  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page).toHaveURL(/\/book\/strategy-call$/);
  await expect(page.locator(".time-grid button").first()).toBeVisible();
  await page.locator(".time-grid button").first().click();
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByLabel("Name").fill(`Gate invitee ${suffix}`);
  await page.getByLabel("Email address").fill(`gate-${suffix}@example.com`);
  await page.getByRole("button", { name: "Review booking" }).click();
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("heading", { name: /You’re booked/ })).toBeVisible();
  await assertNoHorizontalOverflow(page);
});

test("@gate the next parameter never leaves the origin", async ({ page }) => {
  await page.goto("/gate?next=//evil.example.com/phish");
  await page.getByLabel("Shop password").fill(process.env.PLAYWRIGHT_CLIENT_GATE_PASSWORD!);
  await page.getByRole("button", { name: "Enter" }).click();
  await page.waitForURL((url) => url.origin === baseURL && !url.pathname.startsWith("/gate"));
  expect(new URL(page.url()).origin).toBe(baseURL);
});
