import { describe, expect, it } from "vitest";
import { surfaceAllows } from "@/server/surface";

describe("origin surface enforcement", () => {
  it("hides every admin surface from the booking origin", () => {
    for (const path of ["/dashboard", "/bookings", "/settings", "/availability", "/event-types/new", "/onboarding", "/forgot-password", "/api/auth/session", "/api/account", "/api/workspace", "/api/event-types", "/api/settings/branding", "/api/integrations/status"]) {
      expect(surfaceAllows("book", path), path).toBe(false);
    }
  });
  it("keeps the organizer booking collection off the booking origin without hiding the manage routes", () => {
    expect(surfaceAllows("book", "/api/bookings")).toBe(false);
    expect(surfaceAllows("admin", "/api/bookings")).toBe(true);
    for (const path of ["/api/bookings/abc", "/api/bookings/abc/slots", "/api/bookings/abc/manage-session", "/api/bookings/manage-link"]) {
      expect(surfaceAllows("book", path), path).toBe(true);
    }
  });
  it("serves the gate, booking, and manage surfaces on the booking origin", () => {
    for (const path of ["/", "/gate", "/book/strategy-call", "/book/strategy-call/confirmation", "/manage/abc/reschedule", "/api/gate", "/api/public/strategy-call/slots", "/api/bookings/abc", "/api/bookings/abc/manage-session", "/api/bookings/manage-link", "/api/health/ready"]) {
      expect(surfaceAllows("book", path), path).toBe(true);
    }
  });
  it("hides the gate and public booking surfaces from the admin origin", () => {
    for (const path of ["/gate", "/api/gate", "/book/strategy-call", "/api/public/strategy-call", "/api/public/strategy-call/bookings"]) {
      expect(surfaceAllows("admin", path), path).toBe(false);
    }
  });
  it("keeps the dashboard, account recovery, and organizer manage links on the admin origin", () => {
    for (const path of ["/", "/dashboard", "/bookings", "/settings", "/onboarding", "/forgot-password", "/reset-password", "/verify-email", "/manage/abc/cancel", "/api/auth/session", "/api/workspace", "/api/bookings/abc", "/api/bookings/abc/slots", "/api/health/live"]) {
      expect(surfaceAllows("admin", path), path).toBe(true);
    }
  });
  it("does not let a prefix bleed across path segments", () => {
    expect(surfaceAllows("admin", "/bookings-export")).toBe(false);
    expect(surfaceAllows("book", "/booking")).toBe(false);
    expect(surfaceAllows("book", "/gatecrash")).toBe(false);
    expect(surfaceAllows("book", "/uppity-ai/strategy-call")).toBe(false);
  });
  it("enforces nothing in the single-origin topology", () => {
    for (const surface of [undefined, "", "both"]) {
      expect(surfaceAllows(surface, "/dashboard")).toBe(true);
      expect(surfaceAllows(surface, "/book/strategy-call")).toBe(true);
    }
  });
});
