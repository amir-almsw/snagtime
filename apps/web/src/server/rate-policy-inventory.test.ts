import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// tempocove_rate_limit() is an allowlist, not a ceiling: it returns false unless the exact
// (limit, window_ms) pair is registered, so an unregistered budget is not "generous", it is
// "429 on the first request, forever". Dev and test use the in-process limiter, which accepts any
// pair, and ci:postgres-rate-policies needs a live PostgreSQL -- so nothing else in the local suite
// can see this. It has already reached production twice: the client gate (fixed by migration
// 202609080001_client_gate_rate_policy) and the dashboard's own booking form.
const apiRoot = resolve(process.cwd(), "apps/web/src/app/api");
const guardsPath = resolve(process.cwd(), "prisma/postgresql/postgres-guards.sql");
const migrationsRoot = resolve(process.cwd(), "prisma/postgresql/migrations");

function sourcePolicies() {
  const pairs = new Map<string, string[]>();
  for (const name of readdirSync(apiRoot, { recursive: true }).filter((entry) => String(entry).endsWith(".ts"))) {
    const source = readFileSync(resolve(apiRoot, String(name)), "utf8");
    for (const match of source.matchAll(/enforceRateLimit\([^,\n]+,\s*([^,\n]+),\s*([^)\n]+)\)/g)) {
      const evaluate = (expression: string) => {
        expect(expression, `nonliteral rate policy in ${String(name)}`).toMatch(/^[\d\s*+_-]+$/);
        return Number(Function(`"use strict";return (${expression})`)());
      };
      const pair = `${evaluate(match[1]!)}|${evaluate(match[2]!)}`;
      pairs.set(pair, [...(pairs.get(pair) ?? []), String(name)]);
    }
  }
  return pairs;
}

// The live table is the baseline's INSERT plus every incremental migration that adds rows, which is
// what a database deployed before those migrations actually holds.
function registeredPolicies() {
  const registered = new Set<string>();
  const collect = (sql: string) => {
    for (const statement of sql.matchAll(/INSERT INTO tempocove_rate_policy[^;]*;/g)) {
      for (const row of statement[0].matchAll(/\(\s*(\d+)\s*,\s*(\d+)\s*\)/g)) registered.add(`${Number(row[1])}|${Number(row[2])}`);
    }
  };
  collect(readFileSync(guardsPath, "utf8"));
  for (const directory of readdirSync(migrationsRoot)) {
    try { collect(readFileSync(resolve(migrationsRoot, directory, "migration.sql"), "utf8")); } catch { /* Not every entry is a migration directory. */ }
  }
  return registered;
}

describe("production rate policy inventory", () => {
  it("registers every rate limit the API routes ask for", () => {
    const registered = registeredPolicies();
    const unregistered = [...sourcePolicies()].filter(([pair]) => !registered.has(pair))
      .map(([pair, files]) => `${pair.replace("|", " per ")}ms (${[...new Set(files)].join(", ")})`);
    expect(unregistered, "add the pair to prisma/postgresql/postgres-guards.sql and ship an incremental migration, or reuse a registered budget").toEqual([]);
  });

  it("reads a real inventory rather than silently matching nothing", () => {
    expect(registeredPolicies().size).toBeGreaterThan(10);
    expect(sourcePolicies().size).toBeGreaterThan(10);
  });
});
