// Creates the single studio admin on a freshly migrated database.
//
// Self-service registration was removed (/signup and /api/auth/register are gone) and prisma/seed.ts
// refuses to run outside DEMO_MODE, so a production deployment has no other way to get its first
// account. Run this once, from an operator-controlled shell, against the owner database URL.
//
//   DATABASE_PROVIDER=postgresql DATABASE_URL=... ADMIN_EMAIL=... ADMIN_PASSWORD=... \
//     node scripts/bootstrap-admin.mjs
//
// Refuses to run if any user already exists, so it can never quietly mint a second operator or
// overwrite the real one. Prints no credentials.
import { createRequire } from "node:module";
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const require = createRequire(import.meta.url);
const provider = process.env.DATABASE_PROVIDER || "sqlite";
if (provider !== "postgresql" && provider !== "sqlite") throw new Error("DATABASE_PROVIDER must be sqlite or postgresql.");

const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || "";
const name = (process.env.ADMIN_NAME || "").trim() || "Studio Admin";
const workspaceName = (process.env.WORKSPACE_NAME || "").trim() || "Studio";
const timeZone = (process.env.WORKSPACE_TIME_ZONE || "").trim() || "Europe/Amsterdam";

if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("ADMIN_EMAIL must be a valid address.");
// Mirrors assertStrongPassword in server/auth/password.ts: the login route would otherwise accept a
// password this deployment's own rules reject on rotation.
if (password.length < 12 || password.length > 200 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
  throw new Error("ADMIN_PASSWORD must be 12-200 characters and include upper, lower, number, and symbol.");
}
try { Intl.DateTimeFormat(undefined, { timeZone }); } catch { throw new Error(`WORKSPACE_TIME_ZONE is not a valid IANA zone: ${timeZone}`); }

// scrypt:v1 with a 16-byte salt and 32-byte key, byte-for-byte what verifyPassword expects.
async function hashPassword(value) {
  const salt = randomBytes(16);
  const derived = await scrypt(value, salt, 32);
  return `scrypt:v1:${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

const { PrismaClient } = require(provider === "postgresql" ? "@tempocove/postgresql-client" : "@prisma/client");
const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
try {
  if (await db.user.count() > 0) throw new Error("Refusing to run: this database already has at least one user.");
  const passwordHash = await hashPassword(password);
  const verifiable = await (async () => {
    const [, , salt, key] = passwordHash.split(":");
    const expected = Buffer.from(key, "base64url");
    return (await scrypt(password, Buffer.from(salt, "base64url"), expected.length)).equals(expected);
  })();
  if (!verifiable) throw new Error("Refusing to run: the generated hash did not verify.");

  const summary = await db.$transaction(async (tx) => {
    // emailVerifiedAt is set here on purpose. The login route rejects an unverified user, and the
    // verify-email flow is admin-surface only, so an unset value would lock the operator out.
    const user = await tx.user.create({ data: { email, name, passwordHash, timeZone, emailVerifiedAt: new Date() } });
    const workspace = await tx.workspace.create({ data: { name: workspaceName, timeZone } });
    await tx.membership.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER", status: "ACTIVE" } });
    return { userId: user.id, workspaceId: workspace.id };
  });
  console.log(JSON.stringify({ created: true, userId: summary.userId, workspaceId: summary.workspaceId, workspaceName, timeZone }));
} finally { await db.$disconnect(); }
