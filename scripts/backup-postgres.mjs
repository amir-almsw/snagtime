// Encrypted PostgreSQL backup for the Linux VPS deployment. The PowerShell pair
// (backup-postgres.ps1 / restore-postgres.ps1) stays for Windows operators; this produces a
// byte-identical container -- same 'TCOVE-PG18-AESGCM-1' header, same 12-byte nonce, 16-byte tag and
// 'TempoCove-PG18-Backup-v1' associated data -- so an archive written by either can be restored by
// either. ci-backup-contract.mjs holds all four files to the same source contract.
//
//   node scripts/backup-postgres.mjs \
//     --pg-dump=/usr/lib/postgresql/18/bin/pg_dump \
//     --database-url-secret=/abs/secrets/app_database_url \
//     --encryption-key-secret=/abs/secrets/backup_key \
//     --encrypted-temp-directory=/abs/var/tmp-backup \
//     --output-directory=/abs/var/backups
//
// pg_dump must match the server's major version. On this stack the simplest correct source is the
// postgres image itself, so --pg-dump may point at a wrapper that shells into the container.
//
// The only thing written to stdout is one compressed JSON object, so a scheduler can consume it.
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { libpqEnvironment } from "./postgres-connection.mjs";

const BACKUP_HEADER = "TCOVE-PG18-AESGCM-1";
const BACKUP_AAD = "TempoCove-PG18-Backup-v1";
const MAX_PLAINTEXT_BYTES = 1073741824;

const args = new Map(process.argv.slice(2).map((item) => { const at = item.indexOf("="); return at === -1 ? [item.replace(/^--/, ""), "true"] : [item.slice(2, at), item.slice(at + 1)]; }));
const arg = (name, required = true) => { const value = args.get(name); if (required && !value) throw new Error(`--${name} is required.`); return value; };

const pgDump = arg("pg-dump");
const databaseUrlSecret = arg("database-url-secret");
const encryptionKeySecret = arg("encryption-key-secret");
const encryptedTempDirectory = arg("encrypted-temp-directory");
const outputDirectory = arg("output-directory");
const allowInsecureLocalTest = args.get("allow-insecure-local-test") === "true";

for (const path of [pgDump, databaseUrlSecret, encryptionKeySecret, encryptedTempDirectory, outputDirectory]) {
  if (!isAbsolute(path)) throw new Error("All backup paths must be absolute.");
}
for (const directory of [encryptedTempDirectory, outputDirectory]) if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
const tempRoot = realpathSync(encryptedTempDirectory);
const outputRoot = realpathSync(outputDirectory);
if (tempRoot === outputRoot) throw new Error("Encrypted temporary and retained backup directories must be distinct.");

const key = Buffer.from(readFileSync(encryptionKeySecret, "utf8").trim(), "base64");
if (key.length !== 32) throw new Error("Backup key must be exactly 32 bytes encoded as base64.");

const environment = libpqEnvironment(readFileSync(databaseUrlSecret, "utf8").trim(), { allowInsecure: allowInsecureLocalTest });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const plain = join(tempRoot, `tempocove-${stamp}.dump`);
const target = join(outputRoot, `tempocove-${stamp}.dump.aesgcm`);

try {
  const dumped = spawnSync(pgDump, ["--format=custom", "--no-owner", "--no-acl", `--file=${plain}`], { env: { ...process.env, ...environment }, stdio: ["ignore", "ignore", "inherit"] });
  if (dumped.status !== 0) throw new Error("pg_dump failed.");
  if (statSync(plain).size > MAX_PLAINTEXT_BYTES) throw new Error("Backup exceeds the bounded 1 GiB encryption contract.");

  const bytes = readFileSync(plain);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(BACKUP_AAD, "utf8"));
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  writeFileSync(target, Buffer.concat([Buffer.from(BACKUP_HEADER, "ascii"), nonce, tag, encrypted]), { mode: 0o600 });

  const sha256 = createHash("sha256").update(readFileSync(target)).digest("hex").toUpperCase();
  process.stdout.write(`${JSON.stringify({ path: target, sha256, createdAt: stamp, encrypted: true })}\n`);
} finally {
  try { unlinkSync(plain); } catch { /* the dump may never have been created */ }
}
