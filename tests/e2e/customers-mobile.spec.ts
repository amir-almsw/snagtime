import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import { assertNoHorizontalOverflow, login } from "./helpers";

const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core/axe.min.js");

// The table head (and its select-all checkbox) is hidden below 820px, so the toolbar control is the
// only way to bulk-select on a phone. It must follow the active search and the rows must stack their
// five cells instead of squeezing the email into the 30px checkbox column.
const clients = [
  { id: "known-amir", name: "Amir El Idrissi", email: "amir.elidrissi@example.nl", phone: "+31 6 12345678", createdAt: "2026-10-01T10:00:00.000Z", blocked: false },
  { id: "known-sanne", name: "Sanne de Vries", email: "sanne.devries@example.nl", phone: null, createdAt: "2026-10-02T10:00:00.000Z", blocked: false },
  { id: "known-blocked", name: "Blocked Person", email: "blocked@example.nl", phone: null, createdAt: "2026-10-03T10:00:00.000Z", blocked: true },
];

test.use({ viewport: { width: 390, height: 844 } });

test("customers keep select-all and stacked fields usable on a phone", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Phone layout only");
  await login(page);
  await page.route("**/api/customers**", (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.continue();
    const path = new URL(request.url()).pathname;
    if (path === "/api/customers") return route.fulfill({ json: { data: clients } });
    if (path === "/api/customers/blacklist") return route.fulfill({ json: { data: [] } });
    return route.continue();
  });
  await page.goto("/customers");
  await expect(page.getByRole("heading", { name: "Customers" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select all customers" })).toHaveCount(1);

  const selectAll = page.locator(".customer-select-all-mobile input");
  await expect(selectAll).toBeVisible();
  await expect(selectAll).not.toBeChecked();

  // With a search active, select-all means every visible row that can receive a message -- not the
  // hidden customers and not the blocked row.
  await page.getByRole("textbox", { name: "Search customers" }).fill("Sanne");
  await expect(page.getByRole("checkbox", { name: "Select Amir El Idrissi" })).toHaveCount(0);
  await selectAll.check();
  await expect(page.getByRole("button", { name: /Message selected \(1\)/ })).toBeEnabled();
  await expect(page.locator(".customer-select-all-mobile")).toContainText("Select all results");

  // Clearing the search reveals the other customers, but only the one chosen under the filter is
  // selected and the select-all state reflects the full visible list again.
  await page.getByRole("textbox", { name: "Search customers" }).fill("");
  await expect(page.getByRole("checkbox", { name: "Select Sanne de Vries" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Select Amir El Idrissi" })).not.toBeChecked();
  await expect(selectAll).not.toBeChecked();

  await selectAll.check();
  await expect(page.getByRole("button", { name: /Message selected \(2\)/ })).toBeEnabled();
  await selectAll.uncheck();
  await expect(page.getByRole("button", { name: "Message selected" })).toBeDisabled();

  // Each field cell owns its row: the email must not share the 30px checkbox track with the phone.
  const row = page.locator(".customer-row.is-selectable").first();
  const email = await row.locator(".customer-cell").nth(1).boundingBox();
  const phone = await row.locator(".customer-cell").nth(2).boundingBox();
  expect(email).not.toBeNull();
  expect(phone).not.toBeNull();
  expect(email!.width).toBeGreaterThan(150);
  expect(email!.y + email!.height).toBeLessThanOrEqual(phone!.y + 0.5);

  const checkbox = await page.locator(".customer-row.is-selectable .customer-check input").first().boundingBox();
  expect(checkbox).not.toBeNull();
  expect(checkbox!.width).toBeGreaterThanOrEqual(18);

  await assertNoHorizontalOverflow(page);
  await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async () => {
    const axe = (window as typeof window & { axe: { run: (context?: unknown, options?: unknown) => Promise<{ violations: unknown[] }> } }).axe;
    return (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] })).violations;
  });
  expect(violations, `customers-mobile: ${JSON.stringify(violations)}`).toEqual([]);
});
