import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("admin pages do not overflow at phone widths", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Phone layout only");
  test.setTimeout(120_000);
  await login(page);
  for (const path of ["/dashboard", "/bookings", "/availability", "/event-types", "/event-types/new", "/settings", "/integrations"]) {
    for (const width of [390, 375, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
      await page.goto(path);
      await page.locator("h1, .editor-topbar").first().waitFor();
      await page.waitForTimeout(700);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} at ${width}px`).toBeLessThanOrEqual(1);
      expect(page.url(), `${path} at ${width}px`).toContain(path);
    }
  }
});
