# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run setup            # writes an ignored .env.local with fresh secrets, prints the demo login once
npm run demo:free        # full local bootstrap: ci + check + generate + migrate + seed + dev
npm run dev              # dev server with .env.local loaded (keeps the embedded outbox poller alive)
npm test                 # vitest
npm run typecheck        # tsc --noEmit against apps/web/tsconfig.json
npm run lint             # eslint apps/web
npm run build            # next build (workspace @snagtime/web)
npm run worker:build     # esbuild bundle -> dist/worker.mjs
npm run prod:check       # validate a production env against the config contract, prints no values
```

Pre-PR suite (from CONTRIBUTING.md): `npm ci && npm run db:generate && npm test && npm run typecheck && npm run lint && npm run build && npm run ci:secret-scan`.

### Single tests

`vitest.config.ts` lives at the repo root, maps `@` to `apps/web/src`, and sets `fileParallelism: false` because integration tests share one local SQLite database. Do not re-enable parallelism.

```bash
npx vitest run apps/web/src/server/services/bookings.test.ts
npx vitest run apps/web/src/server/services/bookings.test.ts -t "rejects a double booking"
npm run test:watch
npm run test:resilience   # curated outbox/notification/rate-limit subset
```

### End-to-end

`npm run test:e2e` runs `scripts/playwright-matrix.mjs`, which loops four projects (chromium/edge × desktop/mobile) sequentially, allocating a fresh port and its own SQLite file per project. Arguments are forwarded:

```bash
npm run test:e2e -- --grep @journey      # also exposed as test:e2e:journey
npm run test:e2e -- --grep @axe
```

Running `npx playwright test` directly needs `PLAYWRIGHT_PORT` and `PLAYWRIGHT_DATABASE_PATH` set, so prefer the matrix script.

### Database

```bash
npm run db:generate            # SQLite client (dev/test)
npm run db:generate:postgres   # derives the PG schema, then generates @tempocove/postgresql-client
npm run db:baseline:postgres   # regenerates the PG baseline migration
npm run db:migrate             # SQLite migrate deploy
npm run db:seed                # SQLite seed
npm run db:reset               # SQLite reset --force
```

The `ci:*` scripts are the same guards CI runs; `ci:postgres-*` need a live PostgreSQL and are the ones to run after touching schema, RLS, or grants.

## Architecture

### Two Prisma schemas, one of them generated

`prisma/schema.prisma` (SQLite) is the **only** hand-edited schema. `scripts/generate-postgres-schema.mjs` derives `prisma/postgresql/schema.prisma` from it by swapping the provider and adding an `output` path, and `scripts/generate-postgres-migration.mjs` produces `prisma/postgresql/migrations/202608220100_production_baseline/migration.sql` as `prisma migrate diff --from-empty` **concatenated with `prisma/postgresql/postgres-guards.sql`**. Both generated files are committed, and `npm run ci:generated-drift` fails the build if regenerating them changes a byte.

Consequences:
- Never edit `prisma/postgresql/schema.prisma` or the baseline migration directly.
- To change RLS policies, integrity triggers, or role grants, edit **`prisma/postgresql/postgres-guards.sql`**, then run `npm run db:baseline:postgres`.
- Schema changes need a SQLite migration in `prisma/migrations/` and, usually, a hand-written incremental migration in `prisma/postgresql/migrations/` (see the `202608240001..0003` directories) since only the baseline is generated.
- The PostgreSQL client is emitted to `node_modules/@tempocove/postgresql-client`, separate from `@prisma/client`. `server/db.ts` `require`s whichever matches `DATABASE_PROVIDER` at runtime.

### The contextual database proxy and row-level security

`server/db.ts` exports `db` as a Proxy around the Prisma client, active **only** when `DATABASE_PROVIDER=postgresql`, `NODE_ENV=production`, and `DATABASE_ROLE !== "worker"`. Under those conditions every model call and raw query is wrapped in a transaction that first runs `installDatabaseContext()` (`server/db-context.ts`), setting `tempocove.mode`, `tempocove.workspace_id`, `tempocove.subject`, `tempocove.action` and an HMAC signature over `TENANT_CONTEXT_SECRET` as session GUCs. PostgreSQL RLS policies verify that signature.

**Request paths must call an `enter*DatabaseContext()` helper before touching `db`** — `enterDatabaseContext`, `enterAuthDatabaseContext`, `enterPublicDatabaseContext`, `enterPublicBookingDatabaseContext`, `enterCapabilityDatabaseContext`, `enterProviderDatabaseContext`, plus `enterBootstrapDatabaseContext` for registration and `enterDatabaseAction` to re-tag an existing context. Omitting it is silent locally (SQLite skips the proxy entirely) and fails the policy check in production. This is the most common class of bug that unit tests will not catch.

### Side effects go through an outbox, never inline

Calendar mutations enqueue `IntegrationOutbox` rows; email enqueues `EmailOutbox`. `server/worker.ts` polls both (`drainDueOutbox`, `processEmailOutbox`) and writes a `WorkerHeartbeat` row that `/api/health/ready` checks — a stalled worker makes the whole app report unready.

Claims are optimistic compare-and-swap: `updateMany` filtered on `status`, a random `leaseToken`, and the booking's `mutationVersion`, rather than row locks. That is why the same code runs on SQLite and PostgreSQL. `EmailOutbox.nextAttemptAt` is honoured by the claim query, so future-dated rows give you scheduled delivery for free.

Do not call Google or SMTP directly from a route handler.

### Fail-closed production contract

Three layers enforce it, and all three must agree:
- `scripts/production-config.mjs` (`npm run prod:check`) — the deploy-time gate.
- `assertProductionRuntimeSecurity()` in `server/auth/session.ts` — the runtime gate, called from health checks and the worker.
- `createDatabaseClient()` in `server/db.ts` — refuses SQLite outside dev.

Production demands PostgreSQL URLs carrying `sslmode=verify-full`, `sslrootcert`, and bounded `connect_timeout`/`pool_timeout`/`connection_limit`/`statement_timeout`; `RATE_LIMIT_PROVIDER=postgresql`; `OUTBOX_WORKER_MODE=dedicated`; `TRUST_PROXY=true`; a 40–64 hex `BUILD_ID` matching the compiled `.next/BUILD_ID`; and mutually independent secrets of at least 32 bytes.

Adding a required environment variable means updating `scripts/production-config.mjs` **and** the `secretNames` array in `scripts/container-entrypoint.mjs` (which loads `*_FILE` values from `/run/secrets/`), plus `.env.example`.

### Three separate credential systems

- **Organizer session** — `server/auth/session.ts`. HMAC-signed cookie (`tempocove_session`) plus an `AuthSession` row; `createSessionForUser` requires an ACTIVE `Membership`, so sessions and RLS both depend on that table.
- **Booking manage capabilities** — `server/auth/capabilities.ts`. Versioned HMAC tokens over `BOOKING_CAPABILITY_SECRET` with a retained keyring (`BOOKING_CAPABILITY_KEYRING`) so rotation does not break links already in inboxes. This is how anonymous invitees cancel and reschedule.
- **Action tokens** — `AccountActionToken` and `BookingRecoveryToken` behind email links.

Public booking is anonymous by design: `Booking.inviteeName`/`inviteeEmail` are plain columns and no invitee account exists.

### Providers are env-selected, with local no-network variants

`CALENDAR_PROVIDER` (`local`|`google`), `EMAIL_PROVIDER` (`local`|`smtp`), `PAYMENTS_PROVIDER` (`stub`|`stripe`). The local/stub implementations make no network calls and are what the credential-free demo uses; production rejects all of them. Google OAuth tokens are encrypted at rest with `TOKEN_ENCRYPTION_KEY` and stored per workspace in `OAuthConnection`.

### Rate limiting and trusted ingress

`enforceRateLimit()` in `server/rate-limit.ts` uses an in-process map in dev and the `tempocove_rate_limit()` SQL function in production (production throws if asked to use the local one). `clientAddress()` returns a real IP **only** when `TRUST_PROXY=true` and the request carries `x-tempocove-proxy-secret` matching `PROXY_SHARED_SECRET`; otherwise every caller collapses into one shared bucket. The proxy must strip client-supplied copies of that header before injecting its own.

## Conventions

API route handlers follow a fixed shape — rate limit first, then work, with a single catch:

```ts
export async function GET(request: Request, context: Context) {
  try {
    await enforceRateLimit(`public-event:ip:${clientAddress(request)}`, 120, 60_000);
    return ok(await something());
  } catch (error) { return apiError(error); }
}
```

`ok`/`apiError` come from `server/http.ts`; throw `AppError` or the `notFound`/`unauthorized`/`conflict` helpers in `server/errors.ts`; validate input with the zod schemas in `server/validation.ts`. `apiError` maps `ZodError` to 422 with field errors.

Tests sit next to their subject as `*.test.ts` under `apps/web/src/**`.

The source is deliberately dense — multiple statements per line and one-line function bodies are the norm in `server/services/`. Match the surrounding file rather than reformatting it; `ci:generated-drift` and the diff-based guards assume stable formatting.

`tempocove` appears throughout as a legacy identifier — cookie names, database roles, session GUCs, SQL function names, the generated client package. It is intentional for migration compatibility and is not customer-facing branding. Do not rename it.

## Project boundaries

From CONTRIBUTING.md and SECURITY.md:
- SQLite is for local development and demos only; never relax the production PostgreSQL requirement.
- Preserve fail-closed behaviour for provider configuration and tenant isolation.
- Stripe live mode is outside the audited release — do not enable it.
- Never commit `.env.local`, provider keys, OAuth tokens, SMTP passwords, database dumps, or URLs containing credentials. `npm run ci:secret-scan` also scans git history in CI.

Deeper references: `docs/DEPLOYMENT.md` (production topology and the `compose.production.yml` contract), `docs/INTEGRATION-SETUP.md` (Google, Stripe, SMTP callbacks and variables), `docs/AI-SETUP.md`.
