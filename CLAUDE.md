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
npm run test:e2e -- --grep @axe          # also exposed as test:e2e:axe
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
- Schema changes need a SQLite migration in `prisma/migrations/` and, usually, a hand-written incremental migration in `prisma/postgresql/migrations/` (the dated directories after the baseline are the pattern; `202609140001_workspace_notification_email` is the latest) since only the baseline is generated. The regenerated baseline serves fresh databases only; the live production database gets the incremental file applied by hand with `psql` before the images are rebuilt.
- The PostgreSQL client is emitted to `node_modules/@tempocove/postgresql-client`, separate from `@prisma/client`. `server/db.ts` `require`s whichever matches `DATABASE_PROVIDER` at runtime.

### The contextual database proxy and row-level security

`server/db.ts` exports `db` as a Proxy around the Prisma client, active **only** when `DATABASE_PROVIDER=postgresql`, `NODE_ENV=production`, and `DATABASE_ROLE !== "worker"`. Under those conditions every model call and raw query is wrapped in a transaction that first runs `installDatabaseContext()` (`server/db-context.ts`), setting `tempocove.mode`, `tempocove.workspace_id`, `tempocove.subject`, `tempocove.action` and an HMAC signature over `TENANT_CONTEXT_SECRET` as session GUCs. PostgreSQL RLS policies verify that signature.

**Request paths must call an `enter*DatabaseContext()` helper before touching `db`** — `enterDatabaseContext`, `enterAuthDatabaseContext`, `enterPublicDatabaseContext`, `enterPublicBookingDatabaseContext`, `enterCapabilityDatabaseContext`, `enterProviderDatabaseContext`, plus `enterBootstrapDatabaseContext` for `registerAccount` in `server/services/accounts.ts` (self-service registration was removed; only tests call it now, and the first admin is created with `npm run db:bootstrap-admin`) and `enterDatabaseAction` to re-tag an existing context. Omitting it is silent locally (SQLite skips the proxy entirely) and fails the policy check in production. This is the most common class of bug that unit tests will not catch.

The store is an `AsyncLocalStorage`, so *where* the helper is called matters as much as whether it is called. A context entered inside a helper after that helper's first `await` is discarded when the helper returns and never reaches the route that awaited it. Enter it in the handler's own frame, or as the first statement of a helper before any `await` (see `authorize()` in `app/api/bookings/[id]/route.ts` and `getSessionRecord()`), and refine an in-flight context with `updateDatabaseContext`/`enterDatabaseAction` rather than re-entering. `manage-session-context.test.ts` shows how to observe the context a route sends when SQLite cannot enforce it.

**Read `prisma/postgresql/postgres-guards.sql` before changing anything the database sees** — which table a service writes, which role writes it, or which context it runs under. Every insert and update needs a policy for that exact role and action, and SQLite tests prove nothing about it: two production 500s in one night came from redirecting studio notices to an address the `EmailOutbox` insert policies did not allow. Reads a policy cannot expose go through `SECURITY DEFINER` functions owned by the verifier role (`tempocove_public_host_busy`, `tempocove_booking_manage_lookup`, `tempocove_workspace_notification_email`) rather than through a widened policy.

### Side effects go through an outbox, never inline

Calendar mutations enqueue `IntegrationOutbox` rows; email enqueues `EmailOutbox`. `server/worker.ts` polls both (`drainDueOutbox`, `processEmailOutbox`) and writes a `WorkerHeartbeat` row that `/api/health/ready` checks — a stalled worker makes the whole app report unready.

Claims are optimistic compare-and-swap: `updateMany` filtered on `status`, a random `leaseToken`, and the booking's `mutationVersion`, rather than row locks. That is why the same code runs on SQLite and PostgreSQL. `EmailOutbox.nextAttemptAt` is honoured by the claim query, so future-dated rows give you scheduled delivery for free.

Do not call Google or SMTP directly from a route handler.

### Availability is database-first

`listPublicSlots` in `server/services/bookings.ts` builds the client-facing slots from the schedule tables plus the host's booked time, and only then merges provider busy intervals. In production the public RLS policy hides every `Booking` row except the caller's own claim, so booked time is read through the `tempocove_public_host_busy` definer function (buffered ranges only, no invitee data); SQLite reads the rows directly. Google FreeBusy is supplementary: a disconnected Google contributes no busy time and a failing one is logged as `provider_busy_unavailable` and skipped, never a 503. Calendar *mutations* still fail closed on the provider recorded in `calendarProviderSnapshot`.

### Fail-closed production contract

Three layers enforce it, and all three must agree:
- `scripts/production-config.mjs` (`npm run prod:check`) — the deploy-time gate.
- `assertProductionRuntimeSecurity()` in `server/auth/session.ts` — the runtime gate, called from health checks and the worker.
- `createDatabaseClient()` in `server/db.ts` — refuses SQLite outside dev.

Production demands PostgreSQL URLs carrying `sslmode=verify-full`, `sslrootcert`, and bounded `connect_timeout`/`pool_timeout`/`connection_limit`/`statement_timeout`; `RATE_LIMIT_PROVIDER=postgresql`; `OUTBOX_WORKER_MODE=dedicated`; `TRUST_PROXY=true`; a 40–64 hex `BUILD_ID` matching the compiled `.next/BUILD_ID`; `SURFACE` equal to `book` or `admin`; `PAYMENTS_PROVIDER=stub`; `CLIENT_GATE_PASSWORD_HASH` as an `scrypt:v1` hash (never a plaintext) with a `CLIENT_GATE_SECRET` independent of `AUTH_SECRET`; and mutually independent secrets of at least 32 bytes.

Adding a required environment variable means updating `scripts/production-config.mjs` **and** the `secretNames` array in `scripts/container-entrypoint.mjs` (which loads `*_FILE` values from `/run/secrets/`), plus `.env.example`.

### Two origins, one codebase

Production runs the same build twice: `web-book` with `SURFACE=book` and `web-admin` with `SURFACE=admin`. `server/surface.ts` holds the per-surface prefix allowlists — the booking origin serves `/gate`, `/book`, `/manage`, `/api/gate`, `/api/public`, `/api/health` and the children of `/api/bookings` (the collection route itself is denied there because it lists every client); the admin origin serves the dashboard pages, the account-recovery pages, `/manage`, and the organizer APIs. `apps/web/src/proxy.ts` enforces it with a 404, never a 403, so a scanner on the booking host cannot learn that an admin surface exists. That file is Next 16's proxy convention: **never add a `middleware.ts`**. `SURFACE` unset means single-origin dev and production refuses it. `NEXT_PUBLIC_APP_URL` is inlined into the server bundle, so each origin is its own image and changing an origin is always a rebuild, never an env change; each container checks only its own `BUILD_ID`, so the two identities may legitimately differ after a release that touched one surface.

### Separate credential systems

- **Organizer session** — `server/auth/session.ts`. HMAC-signed cookie (`tempocove_session`) plus an `AuthSession` row; `createSessionForUser` requires an ACTIVE `Membership`, so sessions and RLS both depend on that table.
- **Booking manage capabilities** — `server/auth/capabilities.ts`. Versioned HMAC tokens over `BOOKING_CAPABILITY_SECRET` with a retained keyring (`BOOKING_CAPABILITY_KEYRING`) so rotation does not break links already in inboxes. This is how anonymous invitees cancel and reschedule.
- **Action tokens** — `AccountActionToken` and `BookingRecoveryToken` behind email links.
- **Client gate** — `server/auth/client-gate.ts`, `/api/gate` and the `/gate` page. One shared studio password, stored only as the `scrypt:v1` hash in `CLIENT_GATE_PASSWORD_HASH`, unlocks the booking surface for 30 days via the `__Host-snag_gate` cookie (`snag_gate` in dev). Rotating the hash does not evict existing cookies unless `CLIENT_GATE_PASSWORD_VERSION` is bumped too.
- **Manage lookup** — `Booking.reference` (a short `DV-XXXXXX` code minted only by `createBooking`) and `/api/bookings/manage-lookup`, which resolves a reference or email through the `tempocove_booking_manage_lookup` definer function and then reuses the manage-link email flow, so a miss is indistinguishable from a hit. The `__Host-snag_booking` cookie only remembers which booking to show on `/book`; it authorises nothing.

Public booking is anonymous by design: `Booking.inviteeName`/`inviteeEmail` are plain columns and no invitee account exists.

### Providers are env-selected, with local no-network variants

`CALENDAR_PROVIDER` (`local`|`google`) and `EMAIL_PROVIDER` (`local`|`smtp`). The local implementations make no network calls and are what the credential-free demo uses; production rejects both. Google OAuth tokens are encrypted at rest with `TOKEN_ENCRYPTION_KEY` and stored per workspace in `OAuthConnection`.

**Payments are removed.** `PAYMENTS_PROVIDER` must be `stub` everywhere and production enforces it. Prices are display-only: the barber sets `priceCents` per duration in the dashboard, clients see it and pay at the shop, and `createBooking` always confirms immediately. The Stripe code in `server/services/payments.ts` and `server/stripe-credentials.ts` is dormant and stays only so old `PENDING_PAYMENT` rows still render; do not wire it back in.

### Rate limiting and trusted ingress

`enforceRateLimit()` in `server/rate-limit.ts` uses an in-process map in dev and the `tempocove_rate_limit()` SQL function in production (production throws if asked to use the local one). `clientAddress()` returns a real IP **only** when `TRUST_PROXY=true` and the request carries `x-tempocove-proxy-secret` matching `PROXY_SHARED_SECRET`; otherwise every caller collapses into one shared bucket. The proxy must strip client-supplied copies of that header before injecting its own.

**Every `(limit, windowMs)` pair passed to `enforceRateLimit` must be registered in `tempocove_rate_policy` in `postgres-guards.sql`** (then regenerate the baseline and write an incremental migration). The production limiter returns false for a pair it does not recognise, so an unregistered call site answers 429 on its very first request, and nothing local catches it because SQLite uses the process-local limiter. Prefer reusing an existing pair. `npm run ci:postgres-rate-policies` checks both directions against a live database; it currently reports three pairs orphaned by deleted routes, which is harmless — `missing=none` is the part that matters.

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

- SQLite is for local development and demos only; never relax the production PostgreSQL requirement.
- Preserve fail-closed behaviour for provider configuration, origin isolation, the client gate, and tenant isolation.
- Payments stay removed: `PAYMENTS_PROVIDER=stub`, no checkout, prices display-only.
- Never commit `.env.local`, provider keys, OAuth tokens, SMTP passwords, database dumps, or URLs containing credentials. `npm run ci:secret-scan` also scans git history in CI.

README.md, CONTRIBUTING.md and SECURITY.md still describe the upstream SnagTime release (Stripe test mode, self-service signup, public self-hosting); where they disagree with this file, this file wins.

## Dvision Studio product rules

This fork is a single-barbershop booking site for Dvision Studio in Amsterdam, not a multi-tenant product.
- Every default timezone is `Europe/Amsterdam`. Test fixtures that book through availability validation must use UTC instants inside the studio's open hours.
- Copy uses studio language: **services** (not event types), **clients** (not invitees), **appointments** (not meetings), **studio** (not organizer or workspace). Organizer emails stay plain text; only the five client emails use the HTML template in `server/services/email-template.ts`.
- There is exactly one admin account and no self-service registration; the seeded `owner@example.com` is it locally, and the first production admin comes from `npm run db:bootstrap-admin`.
- Service names, prices and durations are the barber's to set in the dashboard. Every upsert in `prisma/seed.ts` is create-only (`update: {}`) so seeding can never overwrite them; tests assert templates and behaviour, never specific names or amounts. The seeded `strategy-call` / `paid-strategy-session` slugs stay because the test suites bind to them.
- The `.dvision` class in `globals.css` themes only client-facing pages (gate, book, manage, outcome). The dashboard keeps the light/dark appearance switch via `data-theme`, so dashboard styles need light and `:root[data-theme=dark]` rules, never `.dvision` ones.
- Internal identifiers deliberately kept: `@snagtime/web`, `SnagTimeApiError`, the `X-SnagTime-Dedupe` header, and everything named `tempocove`.

## Live deployment

The site runs on a single VPS from `compose.production.yml`: Caddy in front of `web-book` (book.dvision.studio), `web-admin` (admin.dvision.studio), `worker`, and PostgreSQL. Images are built on the box with the commit SHA as `BUILD_ID`, one per origin; `production.env` and an untracked `compose.ops.yml` exist only on the server. The owner runs every deploy step by hand from a runbook kept outside the repo — hand over commands, never run them. Outbound SMTP goes to Brevo on port 2525 because the host blocks 25, 465 and 587.

Deeper references: `docs/DEPLOYMENT.md` (production topology and the `compose.production.yml` contract) and `docs/INTEGRATION-SETUP.md` (Google and SMTP callbacks and variables).
