// Shared libpq connection resolver for the Linux backup and restore scripts. It lives in its own
// module with no top-level side effects on purpose: importing it must never run another script's
// argument parsing, which is exactly what happened when restore-postgres.mjs reached into
// backup-postgres.mjs for this function and inherited its "--pg-dump is required" exit.
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

// Resolves the connection secret into libpq environment variables rather than passing a URL on the
// command line, where it would sit in the host's process table for the life of the dump or restore.
export function libpqEnvironment(databaseUrl, { allowInsecure = false } = {}) {
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) throw new Error("PostgreSQL URL required.");
  const url = new URL(databaseUrl);
  const query = url.searchParams;
  const environment = {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password || ""),
  };
  if (query.get("sslmode") === "verify-full") {
    environment.PGSSLMODE = "verify-full";
    const rootCert = query.get("sslrootcert");
    if (!rootCert || !isAbsolute(rootCert) || !existsSync(rootCert)) throw new Error("verify-full requires an existing absolute sslrootcert.");
    environment.PGSSLROOTCERT = rootCert;
    for (const [name, variable] of [["sslcert", "PGSSLCERT"], ["sslkey", "PGSSLKEY"]]) {
      const value = query.get(name);
      if (!value) continue;
      if (!isAbsolute(value) || !existsSync(value)) throw new Error(`${name} must be an existing absolute path.`);
      environment[variable] = value;
    }
    return environment;
  }
  // The escape hatch exists only so the contract can be exercised against a loopback fixture; it can
  // never apply to a remote host, and never without the operator asking for it explicitly.
  if (allowInsecure && query.get("sslmode") === "disable" && ["127.0.0.1", "localhost"].includes(url.hostname)) {
    environment.PGSSLMODE = "disable";
    return environment;
  }
  throw new Error("Backup and restore require sslmode=verify-full; only explicit loopback tests may disable TLS.");
}
