import { expect, test } from "@playwright/test";
import { passClientGate } from "./helpers";

// Two active services are seeded, so the directory is where a client lands after the gate and every service
// page offers a way back to it. Bound to the seeded slugs, never to names or prices.
test("@service-choice a client can change the chosen service, and a single-duration service skips the duration chooser", async ({ page, context }) => {
  await passClientGate(context);
  await page.goto("/book");
  await expect(page.getByRole("heading", { name: "What are we doing today?" })).toBeVisible();
  await page.locator('a[href="/book/strategy-call"]').click();
  await expect(page).toHaveURL(/\/book\/strategy-call$/);
  // This service has two durations, so the chooser stays and remains a real choice.
  await expect(page.getByRole("heading", { name: "Choose a duration" })).toBeVisible();
  await expect(page.locator(".duration-options button")).toHaveCount(2);
  await page.getByRole("link", { name: "Change service" }).click();
  await expect(page).toHaveURL(/\/book$/);
  await page.locator('a[href="/book/paid-strategy-session"]').click();
  await expect(page).toHaveURL(/\/book\/paid-strategy-session$/);
  // One duration: nothing to choose, so no duration buttons render and the date heading leads the step.
  await expect(page.getByRole("heading", { name: "Choose a date and time" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Choose a duration" })).toHaveCount(0);
  await expect(page.locator(".duration-options")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Change service" })).toBeVisible();
});
