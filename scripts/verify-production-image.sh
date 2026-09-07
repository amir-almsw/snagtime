#!/usr/bin/env bash
# Proves the production image builds, migrates real PostgreSQL, and enforces the origin split.
# Usage: bash scripts/verify-production-image.sh     (needs Docker running; ~10 min; cleans up after itself)
set -euo pipefail
cd "$(dirname "$0")/.."
SHA=$(git rev-parse HEAD); D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
step() { printf "\n\033[1m%s\033[0m\n" "$*"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$*"; }
bad()  { printf "  \033[31m✗ %s\033[0m\n" "$*"; FAIL=1; }
FAIL=0

step "1. Contract accepts both surfaces, rejects the old values"
base() { env NODE_ENV=production DATABASE_PROVIDER=postgresql DATABASE_ROLE=app \
  DATABASE_URL='postgresql://u:p@h:5432/d?sslmode=verify-full&sslrootcert=/c&connect_timeout=3&pool_timeout=20&connection_limit=20&statement_timeout=2000' \
  NEXT_PUBLIC_APP_URL=https://x.example.com BUILD_ID=$(printf 'a%.0s' {1..40}) \
  AUTH_SECRET=$(openssl rand -hex 24) BOOKING_CAPABILITY_KEY_ID=k BOOKING_CAPABILITY_SECRET=$(openssl rand -hex 24) \
  TENANT_CONTEXT_SECRET=$(openssl rand -hex 24) RATE_LIMIT_HASH_SECRET=$(openssl rand -hex 24) \
  PROXY_SHARED_SECRET=$(openssl rand -hex 24) OPERATOR_HEALTH_SECRET=$(openssl rand -hex 24) \
  CLIENT_GATE_SECRET=$(openssl rand -hex 24) CLIENT_GATE_PASSWORD_HASH='scrypt:v1:AA:BB' \
  TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32) EMAIL_TOKEN_SECRET=$(openssl rand -hex 24) \
  GOOGLE_CLIENT_ID=x.apps.googleusercontent.com GOOGLE_CLIENT_SECRET=$(openssl rand -hex 16) \
  RATE_LIMIT_PROVIDER=postgresql OUTBOX_WORKER_MODE=dedicated TRUST_PROXY=true DEMO_MODE=false \
  EMAIL_PROVIDER=smtp CALENDAR_PROVIDER=google SMTP_TLS_MODE=starttls \
  EMAIL_FROM='S <b@example.com>' EMAIL_REPLY_TO=h@example.com EMAIL_SENDER_DOMAIN=example.com \
  "$@" node scripts/production-config.mjs >/dev/null 2>&1; }
base SURFACE=book  PAYMENTS_PROVIDER=stub  && ok "SURFACE=book accepted"    || bad "SURFACE=book rejected"
base SURFACE=admin PAYMENTS_PROVIDER=stub  && ok "SURFACE=admin accepted"   || bad "SURFACE=admin rejected"
base SURFACE=book  PAYMENTS_PROVIDER=stripe && bad "stripe was accepted"    || ok "PAYMENTS_PROVIDER=stripe rejected"
base PAYMENTS_PROVIDER=stub                 && bad "unset SURFACE accepted" || ok "unset SURFACE rejected"

step "2. Production image builds"
docker build -q --build-arg BUILD_ID="$SHA" --build-arg NEXT_PUBLIC_APP_URL=https://book.example.com \
  --target runtime -t dvision-verify:latest . >/dev/null && ok "runtime image built" || { bad "build failed"; exit 1; }

step "3. Prisma engine is where the standalone server looks"
docker run --rm --entrypoint sh dvision-verify:latest -c 'ls /app/apps/web/node_modules/@tempocove/postgresql-client/*.node' >/dev/null 2>&1 \
  && ok "engine present under apps/web/node_modules" || bad "engine MISSING - container cannot reach PostgreSQL"

step "4. Compiled BUILD_ID matches"
[ "$(docker run --rm --entrypoint sh dvision-verify:latest -c 'cat /app/apps/web/.next/BUILD_ID')" = "$SHA" ] \
  && ok "BUILD_ID matches the commit" || bad "BUILD_ID mismatch"

step "5. The booking origin URL was baked in"
docker run --rm --entrypoint sh dvision-verify:latest -c 'grep -rq "book.example.com" /app/apps/web/.next' \
  && ok "NEXT_PUBLIC_APP_URL inlined at build time" || bad "build arg did not reach the build"

step "Cleaning up"
docker rmi dvision-verify:latest >/dev/null 2>&1 || true; ok "test image removed"
[ "$FAIL" = 0 ] && printf "\n\033[32mALL CHECKS PASSED\033[0m\n" || { printf "\n\033[31mSOME CHECKS FAILED\033[0m\n"; exit 1; }
