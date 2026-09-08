# Deployment guide

## Choose the right deployment shape

SnagTime is a stateful Next.js application with API routes, a relational database, OAuth callbacks, webhooks, and asynchronous calendar and email work.

It cannot be deployed as static files. ChatGPT Sites is not compatible with this application. Vercel is not supported out of the box because the audited production design requires a continuously running worker and role-separated PostgreSQL connections.

Use infrastructure that supports:

- A long-running Node.js web container
- A separate long-running worker container
- PostgreSQL 18 with persistent storage and verified TLS
- HTTPS ingress with a stable domain
- Runtime secret injection
- Scheduled encrypted backups

A Linux VPS with Docker is the most direct fit. Container platforms can also work if they provide all of the capabilities above, but the included production Compose file is a reference deployment contract, not a one-click template for a particular vendor.

## Local versus production

| Area | Local demo | Production contract |
|---|---|---|
| Database | SQLite | PostgreSQL 18 |
| Rate limiting | Process-local | PostgreSQL-backed |
| Background work | Embedded in web process | Dedicated worker |
| URL | `http://localhost:3000` | Canonical HTTPS origin |
| Secrets | Ignored `.env.local` | Secret manager or mounted secret files |
| Calendar | Local or Google | Google |
| Email | Local inbox or SMTP | TLS SMTP |
| Payments | Stub or Stripe test | Stripe test only |

Do not expose the local demo configuration to the public internet.

## Local HTTPS ingress

The table above describes the SQLite demo. Running the *production* stack on a workstation is a
different exercise, and it cannot be driven over `http://localhost:PORT`: the configuration contract
requires a canonical HTTPS origin, and `assertSameOrigin()` rejects any `Origin` that does not match
it, so publishing the container ports and browsing them directly returns 401 on every login and every
gate submission. Put the same shape of proxy in front locally:

```bash
docker compose -f compose.production.yml -f compose.local-tls.yml --env-file test.env up -d
```

`compose.local-tls.yml` adds a Caddy service using `infrastructure/caddy/Caddyfile.local`, which
serves `$BOOK_HOST` and `$ADMIN_HOST` from Caddy's own local CA and applies the same delete-then-set
header discipline as production ingress. Set four values in your env file, keeping each host and its
URL in agreement:

```text
BOOK_HOST=book.localhost
ADMIN_HOST=admin.localhost
BOOK_APP_URL=https://book.localhost
ADMIN_APP_URL=https://admin.localhost
```

`*.localhost` resolves to the loopback address on macOS and Linux with no `/etc/hosts` entry. Any
other hostname needs one.

The origins are compiled into the images, so rebuild after changing them:

```bash
docker compose -f compose.production.yml -f compose.local-tls.yml --env-file test.env build web-book web-admin worker
docker compose -f compose.production.yml -f compose.local-tls.yml --env-file test.env up -d
```

Browsers reject the locally issued certificates until you trust the CA root:

```bash
docker cp snagtime-production-caddy-1:/data/caddy/pki/authorities/local/root.crt /tmp/caddy-local-root.crt
# macOS
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain /tmp/caddy-local-root.crt
# Debian and Ubuntu
sudo cp /tmp/caddy-local-root.crt /usr/local/share/ca-certificates/caddy-local-root.crt && sudo update-ca-certificates
```

The overlay still publishes 3100 and 3200 for health probes and container debugging. Requests sent
straight to those ports carry an `Origin` the app does not accept and will 401 by design; drive the
application through the proxy hostnames.

This is a rehearsal of production ingress, not a production configuration. Certificates are locally
issued, and on Docker Desktop for macOS every request reaches Caddy from the Docker gateway address,
so `x-forwarded-for` carries that single address rather than distinct client IPs. On a Linux host,
bridge networking preserves the real source address.

## Production components

The repository provides:

- `Dockerfile` target `runtime` for both web and worker
- `Dockerfile` target `migration` for database migrations
- `compose.production.yml` as the required service and secret topology
- `compose.local-tls.yml` and `infrastructure/caddy/Caddyfile.local` for exercising that stack locally over HTTPS
- `infrastructure/postgresql/` for PostgreSQL TLS and host-based access controls
- `prisma/postgresql/` for the generated schema, baseline migration, row-level security, and runtime guards
- `scripts/provision-postgres-logins.mjs` for separate migration, app, worker, and monitor credentials
- `scripts/backup-postgres.ps1` and `scripts/restore-postgres.ps1` for encrypted backup and restore workflows

Historical internal identifiers beginning with `tempocove` remain in database roles and generated artifacts for migration compatibility. They are not customer-facing branding.

## Deployment sequence

### 1. Prepare a domain and HTTPS ingress

Choose the final origin before configuring providers, for example:

```text
https://book.your-domain.example
```

Your reverse proxy must terminate HTTPS, strip any incoming proxy-authentication header from the client, inject the trusted `PROXY_SHARED_SECRET`, and forward requests to the web container.

Both halves of that matter. `clientAddress()` treats `x-tempocove-proxy-secret` as proof that a
request arrived through trusted ingress, and only then reads the first `x-forwarded-for` entry as the
client IP. A proxy that forwards the client's own copy of either header lets a caller forge its
source address and walk past the per-IP limits on `/api/gate` and `/api/auth/session`:

```caddyfile
book.your-domain.example {
	reverse_proxy web-book:3000 {
		header_up X-Tempocove-Proxy-Secret {env.PROXY_SHARED_SECRET}
		header_up X-Forwarded-For {remote_host}
	}
}
```

`header_up Name value` *sets* the header, replacing whatever the client sent, and setting
`x-forwarded-for` to `{remote_host}` overwrites the client's chain rather than appending to it. That
is the whole defence.

Do **not** add a `header_up -X-Tempocove-Proxy-Secret` delete line in front of the set. Caddy applies
deletions after sets, so the delete removes the value just injected and the upstream receives no
header at all. The failure is closed rather than open, but `clientAddress()` then returns the
constant `global-untrusted-proxy` and every visitor on the internet shares one rate-limit bucket:
twelve login attempts per fifteen minutes becomes a global budget, so anyone can lock the single
admin account out at will, and five wrong gate passwords lock the gate for everybody.

The same applies to a proxy that cannot inject the header at all.

#### A mismatched origin looks exactly like a bad password

`assertSameOrigin()` runs first in both `POST /api/auth/session` and `POST /api/gate`, comparing the
browser's `Origin` against `NEXT_PUBLIC_APP_URL` and throwing 401 on any mismatch, before either
route reads the submitted password. Admin login and the client gate therefore fail identically and
simultaneously when the origin is wrong, which presents as "the password stopped working" on both
surfaces at once. Tell the cases apart by the error code in the response body:

| Response code | Meaning |
|---|---|
| `UNAUTHORIZED`, "Sign in to continue." | Origin rejected; the password was never checked |
| `AUTHENTICATION_FAILED`, "Email or password is invalid." | Origin accepted; the credential really is wrong, or the account is unverified or has no ACTIVE membership |
| `CLIENT_GATE_REQUIRED` | Gate cookie missing or expired |
| `RATE_LIMITED` | Bucket exhausted; see the ingress note above |

Because `NEXT_PUBLIC_APP_URL` is inlined at build time (step 4), the compiled literal wins over
whatever you set at runtime. Changing an origin means rebuilding that image, not just editing the
environment.

### 2. Prepare PostgreSQL 18

Use PostgreSQL 18 with verified TLS. The production URLs must include:

```text
sslmode=verify-full
sslrootcert=/absolute/or/container/path/to/ca.crt
connect_timeout=3
pool_timeout=20
connection_limit=20
statement_timeout=2000
```

The exact app, worker, migration, and monitor URLs use different database logins. Bootstrap owner credentials must never be mounted into the web or worker container.

Generate and validate the PostgreSQL artifacts:

```bash
npm ci
npm run db:generate:postgres
npm run db:baseline:postgres
```

Provision the runtime logins from an operator-controlled environment:

```bash
npm run db:provision:postgres-logins
```

That command requires the bootstrap database URL plus independent values for:

- `TEMPOCOVE_MIGRATION_DB_PASSWORD`
- `TEMPOCOVE_APP_DB_PASSWORD`
- `TEMPOCOVE_WORKER_DB_PASSWORD`
- `TEMPOCOVE_MONITOR_DB_PASSWORD`
- `TENANT_CONTEXT_SECRET`

### 3. Create independent application secrets

Required application secrets include:

- `AUTH_SECRET`
- `BOOKING_CAPABILITY_SECRET`
- `BOOKING_CAPABILITY_KEYRING`
- `TOKEN_ENCRYPTION_KEY`, exactly 64 hexadecimal characters
- `EMAIL_TOKEN_SECRET`
- `TENANT_CONTEXT_SECRET`
- `RATE_LIMIT_HASH_SECRET`
- `PROXY_SHARED_SECRET`
- `OPERATOR_HEALTH_SECRET`
- Provider secrets for Google, Stripe test mode, and SMTP

Every secret must be independent. Store them in the platform's secret manager or mount them as files. Never bake them into an image.

### 4. Build immutable images

`NEXT_PUBLIC_APP_URL` is inlined by Next.js at build time, so the booking and admin
origins need one image each. Use the 40-character Git commit SHA as the build identity:

```bash
SHA=$(git rev-parse HEAD)
docker build --build-arg BUILD_ID="$SHA" --target runtime \
  --build-arg NEXT_PUBLIC_APP_URL=https://book.your-domain.example \
  -t snagtime-book:"$SHA" .
docker build --build-arg BUILD_ID="$SHA" --target runtime \
  --build-arg NEXT_PUBLIC_APP_URL=https://admin.your-domain.example \
  -t snagtime-admin:"$SHA" .
docker build --target migration -t snagtime-migration:"$SHA" .
```

The runtime refuses to start when its configured `BUILD_ID` does not match the compiled build,
so `BOOK_BUILD_ID` and `ADMIN_BUILD_ID` must both be set to the identity each image was built with.

### 5. Run migration, web, and worker

Run the migration image with the migration database URL first. Then run three copies of the runtime image:

- `web-book` — `node apps/web/server.js` with `SURFACE=book`
- `web-admin` — `node apps/web/server.js` with `SURFACE=admin`
- `worker` — `node dist/worker.mjs`

`SURFACE` must never be left unset in production. Unset means single-origin mode, which serves the
dashboard on the public booking host; the configuration contract rejects anything but `book` or
`admin` so this cannot happen silently.

Use `compose.production.yml` to see the required environment split and secret mounts for each service.

Secrets are file-backed, mounted from `./secrets/` next to the compose file, because Docker Swarm's
`external: true` is not supported by plain `docker compose` and fails with `unsupported external
secret`. Create them once:

```bash
bash scripts/init-production-secrets.sh   # generates the random values, flags the rest as TODO
```

The directory is created mode 700, every file mode 600, and `/secrets/` is gitignored. Fill in each
`TODO` placeholder before deploying. If you later move to Swarm or Kubernetes, switch the block back
to `external: true` and let the orchestrator provide them.

Confirm the split before sharing any link:

```bash
curl -I https://book.your-domain.example/dashboard   # must be 404
curl -I https://admin.your-domain.example/gate       # must be 404
```

### 6. Configure providers

Follow [Integration setup](INTEGRATION-SETUP.md). The hosted callbacks use the final HTTPS origin.

### 7. Verify before sharing a booking link

At minimum:

1. Confirm `/api/health/live` responds.
2. Confirm `/api/health/ready` reports ready. This also proves the worker is writing heartbeats.
3. Run `npm run ci:postgres-rate-policies` against the live database. See the note below.
4. Sign in as the bootstrapped admin and confirm the dashboard loads.
5. Enter the client gate with the studio password on the booking origin.
6. Confirm the origin split: `/dashboard` returns 404 on the booking host, `/gate` returns 404 on the admin host.
7. Connect Google Calendar and verify free/busy blocking.
8. Create, reschedule, and cancel a booking.
9. Confirm organizer and invitee SMTP delivery from unrelated mailboxes.
10. Restart web and worker containers and verify data remains intact.
11. Run an encrypted backup and restore it into an isolated empty database.

There is no self-service registration: `/signup` and `/api/auth/register` were removed, so the first
admin is created out of band. Payments are removed too, and the configuration contract requires
`PAYMENTS_PROVIDER=stub`, so there is no checkout to exercise.

#### Every rate limit must be registered, or the endpoint is dead

`tempocove_rate_limit()` is an allowlist, not just a counter. Its first statement returns `false`
unless the exact `(limit, window_ms)` pair appears in the `tempocove_rate_policy` table, which stops
a caller inventing its own limits. The consequence is unforgiving: **an unregistered policy does not
mean "unlimited", it means "rejected every time"**, so the endpoint answers 429 to everyone on the
first request and the window never clears.

Adding an `enforceRateLimit(...)` call therefore means adding its pair to the `INSERT INTO
tempocove_rate_policy` line in `prisma/postgresql/postgres-guards.sql`, regenerating with
`npm run db:baseline:postgres`, and writing an incremental migration for databases already deployed.

`npm run ci:postgres-rate-policies` proves the two sides agree in both directions — it fails on a
call site with no policy *and* on a policy no call site uses. It needs a live PostgreSQL, so it is
easy to skip during development; skipping it is how `/api/gate` shipped permanently rate-limited.
Nothing catches this locally, because the SQLite path uses the process-local limiter, which has no
allowlist and accepts any pair.

## Platform notes

### Vercel

Not supported by this repository's current production contract. The web frontend is Next.js, but the system also needs PostgreSQL runtime roles and a dedicated continuously running worker.

### ChatGPT Sites

Not compatible. This is not a static site and needs server-side code, persistent storage, OAuth callbacks, and webhooks.

### Railway, Render, Fly.io, and similar platforms

Potentially compatible if configured as separate web and worker services with PostgreSQL, stable HTTPS, mounted secrets, and the required database TLS posture. No one-click template is included or verified in this release.

### Linux VPS with Docker

The closest match to the included architecture because you control the reverse proxy, certificates, PostgreSQL container, secret mounts, worker, and backups. It also carries the most operational responsibility.

## Operational ownership

The MIT-licensed software is free. A public service is not maintenance-free. The deployer owns:

- Hosting and domain costs
- Database capacity and backups
- Security updates and dependency alerts
- Google OAuth consent and verification requirements
- SMTP reputation, SPF, DKIM, DMARC, and deliverability
- Stripe account configuration and any future live-mode implementation
- Privacy policy, terms, data retention, and regulatory obligations
- Monitoring, incident response, and disaster recovery
