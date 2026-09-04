import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGateToken, gateCookieName, readGateToken, requireClientGate, verifyGatePassword } from "@/server/auth/client-gate";
import { hashPassword } from "@/server/auth/password";
import { resetRateLimitsForTest } from "@/server/rate-limit";
import { POST } from "@/app/api/gate/route";

const GATE_PASSWORD = "Fresh-Fade!2026";
const preserved = ["CLIENT_GATE_SECRET", "CLIENT_GATE_PASSWORD_HASH", "CLIENT_GATE_PASSWORD_VERSION", "NEXT_PUBLIC_APP_URL"] as const;
const original = Object.fromEntries(preserved.map((name) => [name, process.env[name]]));

beforeEach(async () => {
  resetRateLimitsForTest();
  process.env.CLIENT_GATE_SECRET = "client-gate-test-secret-that-is-at-least-32-bytes";
  process.env.CLIENT_GATE_PASSWORD_HASH = await hashPassword(GATE_PASSWORD);
  delete process.env.CLIENT_GATE_PASSWORD_VERSION;
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
});
afterEach(() => { for (const name of preserved) { if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name]; } });

function gateRequest(body: unknown) {
  return new Request("http://localhost:3000/api/gate", { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("client gate tokens", () => {
  it("round-trips a signed payload inside its lifetime", () => {
    const token = createGateToken(1_000);
    expect(readGateToken(token, 2_000)?.version).toBe(1);
  });
  it("rejects tampered signatures and expired payloads", () => {
    const token = createGateToken(1_000);
    expect(readGateToken(`${token.slice(0, -1)}x`, 2_000)).toBeNull();
    expect(readGateToken(token, 1_000 + 31 * 24 * 60 * 60 * 1000)).toBeNull();
  });
  it("rejects a cookie minted at version 1 once the password version is bumped", () => {
    const token = createGateToken(1_000);
    expect(readGateToken(token, 2_000)).not.toBeNull();
    process.env.CLIENT_GATE_PASSWORD_VERSION = "2";
    expect(readGateToken(token, 2_000)).toBeNull();
  });
  it("fails closed on requests without a valid gate cookie", () => {
    expect(() => requireClientGate(new Request("http://localhost:3000/api/public/x"))).toThrow(/shop password/);
    const gated = new Request("http://localhost:3000/api/public/x", { headers: { cookie: `${gateCookieName()}=${createGateToken()}` } });
    expect(() => requireClientGate(gated)).not.toThrow();
  });
});

describe("client gate password", () => {
  it("accepts the configured password and rejects everything else, including when unconfigured", async () => {
    expect(await verifyGatePassword(GATE_PASSWORD)).toBe(true);
    expect(await verifyGatePassword("wrong-password")).toBe(false);
    delete process.env.CLIENT_GATE_PASSWORD_HASH;
    expect(await verifyGatePassword(GATE_PASSWORD)).toBe(false);
  });
});

describe("POST /api/gate", () => {
  it("issues a gate cookie for the correct password only", async () => {
    const granted = await POST(gateRequest({ password: GATE_PASSWORD }));
    expect(granted.status).toBe(200);
    expect(granted.headers.get("set-cookie")).toContain(`${gateCookieName()}=`);
    const denied = await POST(gateRequest({ password: "wrong-password" }));
    expect(denied.status).toBe(401);
    expect(denied.headers.get("set-cookie")).toBeNull();
  });
  it("rate limits password attempts before hashing", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) await POST(gateRequest({ password: "wrong-password" }));
    const limited = await POST(gateRequest({ password: GATE_PASSWORD }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("set-cookie")).toBeNull();
  });
});
