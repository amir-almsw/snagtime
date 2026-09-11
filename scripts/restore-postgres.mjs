// Restores an archive written by backup-postgres.mjs or backup-postgres.ps1 into an isolated, empty
// target, then runs postgres-restore-verify.sql so a restore that "succeeded" but lost an authority
// guard is still caught. Never point this at a live database: the confirmation flag is mandatory and
// deliberately unpleasant to type.
//
//   node scripts/restore-postgres.mjs \
//     --pg-restore=/usr/lib/postgresql/18/bin/pg_restore \
//     --psql=/usr/lib/postgresql/18/bin/psql \
//     --target-database-url-secret=/abs/secrets/restore_target_url \
//     --encryption-key-secret=/abs/secrets/backup_key \
//     --encrypted-temp-directory=/abs/var/tmp-restore \
//     --backup-path=/abs/var/backups/tempocove-....dump.aesgcm \
//     --expected-sha256=<digest printed by the backup> \
//     --confirm-isolated-empty-target
//
// "Isolated" is literal: infrastructure/postgresql/pg_hba.conf permits TCP only to the `tempocove`
// database, so a restore target on the same server is refused before pg_restore starts. Restore into a
// separate PostgreSQL instance -- which is what you want anyway, since a rehearsal that shares a server
// with production can still take production down. Verifying an archive without restoring it at all is
// `pg_restore --list`, which needs no connection.
//
// The only thing written to stdout is one compressed JSON object.
import { createDecipheriv, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { libpqEnvironment } from "./postgres-connection.mjs";

const BACKUP_HEADER = "TCOVE-PG18-AESGCM-1";
const BACKUP_AAD = "TempoCove-PG18-Backup-v1";

const args = new Map(process.argv.slice(2).map((item) => { const at = item.indexOf("="); return at === -1 ? [item.replace(/^--/, ""), "true"] : [item.slice(2, at), item.slice(at + 1)]; }));
const arg = (name, required = true) => { const value = args.get(name); if (required && !value) throw new Error(`--${name} is required.`); return value; };

if (args.get("confirm-isolated-empty-target") !== "true") throw new Error("Restore requires explicit isolated-target confirmation.");
const pgRestore = arg("pg-restore");
const psql = arg("psql");
const targetDatabaseUrlSecret = arg("target-database-url-secret");
const encryptionKeySecret = arg("encryption-key-secret");
const encryptedTempDirectory = arg("encrypted-temp-directory");
const backupPath = arg("backup-path");
const expectedSha256 = arg("expected-sha256");
const allowInsecureLocalTest = args.get("allow-insecure-local-test") === "true";

for (const path of [pgRestore, psql, targetDatabaseUrlSecret, encryptionKeySecret, encryptedTempDirectory, backupPath]) {
  if (!isAbsolute(path)) throw new Error("All restore paths must be absolute.");
}

const archive = readFileSync(backupPath);
const actual = createHash("sha256").update(archive).digest("hex").toUpperCase();
if (actual !== expectedSha256.toUpperCase()) throw new Error("Backup digest mismatch.");

const key = Buffer.from(readFileSync(encryptionKeySecret, "utf8").trim(), "base64");
if (key.length !== 32) throw new Error("Restore key must be 32 bytes.");
if (archive.subarray(0, 19).toString("ascii") !== BACKUP_HEADER) throw new Error("Backup format mismatch.");

const decipher = createDecipheriv("aes-256-gcm", key, archive.subarray(19, 31));
decipher.setAAD(Buffer.from(BACKUP_AAD, "utf8"));
decipher.setAuthTag(archive.subarray(31, 47));
const plain = Buffer.concat([decipher.update(archive.subarray(47)), decipher.final()]);

if (!existsSync(encryptedTempDirectory)) mkdirSync(encryptedTempDirectory, { recursive: true, mode: 0o700 });
const temp = join(realpathSync(encryptedTempDirectory), `restore-${randomUUID().replaceAll("-", "")}.dump`);
writeFileSync(temp, plain, { mode: 0o600 });

const environment = libpqEnvironment(readFileSync(targetDatabaseUrlSecret, "utf8").trim(), { allowInsecure: allowInsecureLocalTest });
try {
  const restored = spawnSync(pgRestore, ["--exit-on-error", "--no-owner", "--no-acl", `--dbname=${environment.PGDATABASE}`, temp], { env: { ...process.env, ...environment }, stdio: ["ignore", "ignore", "inherit"] });
  if (restored.status !== 0) throw new Error("pg_restore failed.");

  const verifySql = join(dirname(fileURLToPath(import.meta.url)), "postgres-restore-verify.sql");
  const verified = spawnSync(psql, ["--no-psqlrc", "--quiet", "--tuples-only", "--set", "ON_ERROR_STOP=1", "--file", verifySql], { env: { ...process.env, ...environment }, encoding: "utf8" });
  if (verified.status !== 0) throw new Error("Restore verification failed.");

  const verificationSha256 = createHash("sha256").update(Buffer.from(verified.stdout.trim(), "utf8")).digest("hex").toUpperCase();
  process.stdout.write(`${JSON.stringify({ restoredAt: new Date().toISOString(), backupSha256: actual, verificationSha256, verified: true })}\n`);
} finally {
  try { unlinkSync(temp); } catch { /* the decrypted dump may already be gone */ }
}
