#!/usr/bin/env bash
# LOCAL ONLY. Fills ./secrets/ with everything compose needs to run the production stack on a
# workstation: the random application secrets, a self-signed PostgreSQL CA and server certificate,
# four strong database logins wired into their URLs, and the studio gate hash.
#
#   STUDIO_GATE_PASSWORD='YourStudioPassword1!' bash scripts/init-local-secrets.sh
#
# Never overwrites a file that already exists, so it is safe to re-run. For a real deployment use
# scripts/init-production-secrets.sh instead and supply the operator-controlled values yourself:
# the certificate below is self-signed and the provider credentials here are placeholders.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -n "${STUDIO_GATE_PASSWORD:-}" ] || { echo "STUDIO_GATE_PASSWORD is required." >&2; exit 64; }

bash scripts/init-production-secrets.sh >/dev/null
mkdir -p secrets && chmod 700 secrets
# init-production-secrets.sh leaves operator-supplied entries as "TODO ..." placeholders, which are
# non-empty, so presence alone is not enough -- a placeholder counts as absent.
needs() { [ ! -s "secrets/$1" ] || head -c 4 "secrets/$1" 2>/dev/null | grep -q '^TODO'; }
write() { if needs "$1"; then printf '%s' "$2" > "secrets/$1"; chmod 600 "secrets/$1"; echo "  wrote $1"; else echo "  kept $1"; fi; }

echo "PostgreSQL TLS (self-signed, CN=postgres):"
if needs postgres_server_cert || needs postgres_ca_cert || needs postgres_server_key; then
  tmp=$(mktemp -d)
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=snagtime-local-ca" \
    -keyout "$tmp/ca.key" -out "$tmp/ca.crt" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=postgres" \
    -keyout "$tmp/server.key" -out "$tmp/server.csr" 2>/dev/null
  # SANs let the same certificate satisfy verify-full from inside the compose network (postgres)
  # and from the host during the one-off provisioning step (127.0.0.1).
  openssl x509 -req -in "$tmp/server.csr" -CA "$tmp/ca.crt" -CAkey "$tmp/ca.key" -CAcreateserial \
    -days 3650 -out "$tmp/server.crt" \
    -extfile <(printf 'subjectAltName=DNS:postgres,DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n') 2>/dev/null
  write postgres_ca_cert     "$(cat "$tmp/ca.crt")"
  write postgres_server_cert "$(cat "$tmp/server.crt")"
  write postgres_server_key  "$(cat "$tmp/server.key")"
  rm -rf "$tmp"
else
  echo "  already present"
fi

echo "Database logins (32-byte passwords, as db:provision:postgres-logins requires):"
common='sslmode=verify-full&sslrootcert=/run/secrets/postgres_ca_cert&connect_timeout=3'
pooled="${common}&pool_timeout=20&connection_limit=20&statement_timeout=2000"
owner_pw=$(cat secrets/postgres_owner_password)
for pair in app:tempocove_app_login worker:tempocove_worker_login monitor:tempocove_monitor_login; do
  name="${pair%%:*}"; role="${pair##*:}"
  [ -s "secrets/${name}_db_password" ] || { openssl rand -hex 32 | tr -d '\n' > "secrets/${name}_db_password"; chmod 600 "secrets/${name}_db_password"; }
  write "${name}_database_url" "postgresql://${role}:$(cat "secrets/${name}_db_password")@postgres:5432/tempocove?${pooled}"
done
[ -s secrets/migration_db_password ] || { openssl rand -hex 32 | tr -d '\n' > secrets/migration_db_password; chmod 600 secrets/migration_db_password; }
# psql reads this one, and rejects Prisma-only parameters, so it carries neither pool nor limit.
write migration_database_url "postgresql://tempocove_owner:${owner_pw}@postgres:5432/tempocove?${common}"

echo "Studio gate hash:"
if needs client_gate_password_hash; then
  hash=$(STUDIO_GATE_PASSWORD="$STUDIO_GATE_PASSWORD" node -e '
    const {randomBytes,scrypt}=require("node:crypto");const {promisify}=require("node:util");
    const s=promisify(scrypt);const salt=randomBytes(16);
    s(process.env.STUDIO_GATE_PASSWORD,salt,32).then(k=>process.stdout.write(`scrypt:v1:${salt.toString("base64url")}:${k.toString("base64url")}`));')
  printf '%s' "$hash" > secrets/client_gate_password_hash; chmod 600 secrets/client_gate_password_hash
  echo "  wrote client_gate_password_hash"
else
  echo "  already present"
fi

echo "Provider placeholders (local stack makes no outbound calls):"
write google_client_secret "local-placeholder-google-client-secret"
write smtp_password        "local-placeholder-smtp-password"

echo
echo "Done. secrets/ is mode 700 and gitignored."
grep -l '^TODO' secrets/* 2>/dev/null | sed 's/^/  STILL A PLACEHOLDER: /' || true
