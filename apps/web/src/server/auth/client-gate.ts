import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "@/server/errors";
import { verifyPassword } from "@/server/auth/password";

const GATE_SECONDS = 60 * 60 * 24 * 30;
// The __Host- prefix requires the Secure attribute, which follows NODE_ENV here; in production it pins the cookie to the booking origin with no Domain attribute.
export function gateCookieName() { return process.env.NODE_ENV === "production" ? "__Host-snag_gate" : "snag_gate"; }
export const gateRequired = () => new AppError("CLIENT_GATE_REQUIRED", "Enter the shop password to continue.", 401);

type GatePayload = { version: number; expiresAt: number; nonce: string };

function gateSecret() {
  const secret = process.env.CLIENT_GATE_SECRET;
  if (secret && Buffer.byteLength(secret) >= 32) return secret;
  if (process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production") return "tempocove-explicit-demo-gate-secret-not-for-production";
  throw new Error("CLIENT_GATE_SECRET with at least 32 bytes is required outside explicit demo mode.");
}

export function gatePasswordVersion() { const version = Number(process.env.CLIENT_GATE_PASSWORD_VERSION || "1"); return Number.isSafeInteger(version) && version >= 1 ? version : 1; }

function encode(value: string) { return Buffer.from(value).toString("base64url"); }
function signature(payload: string) { return createHmac("sha256", gateSecret()).update(payload).digest("base64url"); }

export function createGateToken(now = Date.now()) {
  const payload = encode(JSON.stringify({ version: gatePasswordVersion(), expiresAt: now + GATE_SECONDS * 1000, nonce: randomBytes(18).toString("base64url") } satisfies GatePayload));
  return `${payload}.${signature(payload)}`;
}

export function readGateToken(token: string | undefined, now = Date.now()): GatePayload | null {
  if (!token) return null;
  const [payload, supplied] = token.split(".");
  if (!payload || !supplied) return null;
  const expected = signature(payload);
  const actualBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as GatePayload;
    if (!parsed.nonce || parsed.version !== gatePasswordVersion() || !Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= now) return null;
    return parsed;
  } catch { return null; }
}

// A dummy hash keeps the unconfigured and wrong-password failure paths on the same scrypt timing.
const DUMMY_GATE_HASH = `scrypt:v1:${Buffer.alloc(16).toString("base64url")}:${Buffer.alloc(32).toString("base64url")}`;

export async function verifyGatePassword(password: string) {
  const encoded = process.env.CLIENT_GATE_PASSWORD_HASH || "";
  const configured = encoded.startsWith("scrypt:");
  const valid = await verifyPassword(password, configured ? encoded : DUMMY_GATE_HASH);
  return configured && valid;
}

function requestCookie(request: Request, name: string) {
  const cookie = request.headers.get("cookie")?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : undefined;
}

export function requireClientGate(request: Request) {
  if (!readGateToken(requestCookie(request, gateCookieName()))) throw gateRequired();
}

export const gateCookieOptions = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: GATE_SECONDS };
